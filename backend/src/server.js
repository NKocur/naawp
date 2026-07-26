import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { pool, query, withTransaction } from './db.js';

const scrypt = promisify(crypto.scrypt);
const app = Fastify({ logger: true, trustProxy: true });
const isProduction = process.env.NODE_ENV === 'production';
const sessionName = 'ever_after_session';
const allRoles = ['owner', 'editor', 'contributor', 'viewer'];
const invitationRoles = ['owner', 'editor', 'contributor', 'viewer'];
const uploadsDirectory = process.env.UPLOADS_DIRECTORY || '/app/uploads';

await app.register(cookie);
await app.register(rateLimit, { global: true, max: 200, timeWindow: '1 minute' });
await app.register(multipart, { limits: { files: 1, fileSize: 20 * 1024 * 1024 } });

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function normalizeEmail(email) { return email.trim().toLowerCase(); }
function invitationToken() { return crypto.randomBytes(32).toString('base64url'); }
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [kind, salt, expected] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !expected) return false;
  const derived = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(derived, Buffer.from(expected, 'hex'));
}
function setSession(reply, token) {
  reply.setCookie(sessionName, token, { httpOnly: true, secure: isProduction, sameSite: 'strict', path: '/', maxAge: 60 * 60 * 24 * 14 });
}
function clearSession(reply) { reply.clearCookie(sessionName, { path: '/' }); }
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '14 days')", [userId, hashToken(token)]);
  return token;
}
async function currentUser(request) {
  const token = request.cookies[sessionName];
  if (!token) return null;
  const result = await query(`SELECT u.id, u.email, u.display_name
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > now()`, [hashToken(token)]);
  return result.rows[0] || null;
}
async function requireUser(request, reply) {
  const user = await currentUser(request);
  if (!user) { reply.code(401).send({ error: 'Authentication required.' }); return null; }
  return user;
}
async function requireMembership(userId, weddingId, allowedRoles) {
  const result = await query('SELECT role FROM memberships WHERE wedding_id = $1 AND user_id = $2', [weddingId, userId]);
  const membership = result.rows[0];
  if (!membership || !allowedRoles.includes(membership.role)) throw httpError('You do not have permission for this workspace.', 403);
  return membership;
}
async function resolveAssignee(client, weddingId, assigneeUserId) {
  if (!assigneeUserId) return { id: null, name: null };
  const result = await client.query(`SELECT u.id,u.display_name FROM memberships m
    JOIN users u ON u.id=m.user_id WHERE m.wedding_id=$1 AND m.user_id=$2`, [weddingId, assigneeUserId]);
  if (!result.rows[0]) throw httpError('The selected assignee is not a member of this workspace.', 400);
  return { id: result.rows[0].id, name: result.rows[0].display_name };
}
async function resolveFinanceMember(client, weddingId, userId, label, fieldName) {
  if (!userId) return { userId: null, label: label || null };
  const result = await client.query(`SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.wedding_id=$1 AND m.user_id=$2`, [weddingId, userId]);
  if (!result.rows[0]) throw httpError(`The selected ${fieldName} is not a member of this workspace.`, 400);
  return { userId: result.rows[0].id, label: null };
}
async function audit(client, weddingId, actorId, entityType, entityId, action, details = {}) {
  await client.query(`INSERT INTO audit_events (wedding_id, actor_id, entity_type, entity_id, action, details)
    VALUES ($1,$2,$3,$4,$5,$6)`, [weddingId, actorId, entityType, entityId, action, details]);
}
async function validInvitation(client, token) {
  const result = await client.query(`SELECT i.*, w.name AS wedding_name
    FROM invitations i JOIN weddings w ON w.id = i.wedding_id
    WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`, [hashToken(token)]);
  return result.rows[0] || null;
}
async function acceptInvitation(client, user, token) {
  const invitation = await validInvitation(client, token);
  if (!invitation) throw httpError('This invitation is invalid, expired, or has already been used.', 404);
  if (invitation.email !== normalizeEmail(user.email)) throw httpError('Sign in with the email address that received this invitation.', 403);
  await client.query(`INSERT INTO memberships (wedding_id, user_id, role) VALUES ($1,$2,$3)
    ON CONFLICT (wedding_id, user_id) DO NOTHING`, [invitation.wedding_id, user.id, invitation.role]);
  await client.query('UPDATE invitations SET accepted_at=now(), accepted_by=$2 WHERE id=$1', [invitation.id, user.id]);
  await audit(client, invitation.wedding_id, user.id, 'invitation', invitation.id, 'accepted', { role: invitation.role });
  return invitation;
}
async function ownerUser(request, reply) {
  const user = await requireUser(request, reply);
  if (!user) return null;
  await requireMembership(user.id, request.params.weddingId, ['owner']);
  return user;
}

app.get('/api/health', async () => ({ ok: true }));
app.get('/api/auth/setup', async () => {
  const result = await query('SELECT EXISTS(SELECT 1 FROM weddings) AS workspace_exists');
  return { workspaceCreationOpen: !result.rows[0].workspace_exists };
});

app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
  const body = z.object({
    email: z.string().email(), password: z.string().min(12).max(128), displayName: z.string().min(1).max(100),
    weddingName: z.string().min(1).max(160).optional(), weddingDate: z.string().date().optional(), location: z.string().max(160).optional(),
    invitationToken: z.string().min(20).max(200).optional()
  }).parse(request.body);
  const email = normalizeEmail(body.email);
  const result = await withTransaction(async client => {
    if (!body.invitationToken) {
      const existingWorkspace = await client.query('SELECT EXISTS(SELECT 1 FROM weddings) AS workspace_exists');
      if (existingWorkspace.rows[0].workspace_exists) throw httpError('Workspace registration is closed. Ask an owner for an invitation.', 403);
    }
    const passwordHash = await hashPassword(body.password);
    let user;
    try {
      user = await client.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id,email,display_name', [email, passwordHash, body.displayName.trim()]);
    } catch (error) {
      if (error.code === '23505') throw httpError('An account already exists for that email. Sign in to accept the invitation.', 409);
      throw error;
    }
    const userRecord = user.rows[0];
    if (body.invitationToken) {
      const invitation = await acceptInvitation(client, userRecord, body.invitationToken);
      const wedding = await client.query('SELECT id,name,wedding_date,location FROM weddings WHERE id=$1', [invitation.wedding_id]);
      return { user: userRecord, wedding: wedding.rows[0], invited: true };
    }
    if (!body.weddingName) throw httpError('A wedding workspace name is required when not joining an invitation.');
    const wedding = await client.query(`INSERT INTO weddings (name, wedding_date, location, created_by)
      VALUES ($1,$2,$3,$4) RETURNING id,name,wedding_date,location`, [body.weddingName.trim(), body.weddingDate || null, body.location?.trim() || null, userRecord.id]);
    await client.query("INSERT INTO memberships (wedding_id,user_id,role) VALUES ($1,$2,'owner')", [wedding.rows[0].id, userRecord.id]);
    await audit(client, wedding.rows[0].id, userRecord.id, 'wedding', wedding.rows[0].id, 'created');
    return { user: userRecord, wedding: wedding.rows[0], invited: false };
  });
  const token = await createSession(result.user.id);
  setSession(reply, token);
  reply.code(201).send(result);
});

app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(1).max(128) }).parse(request.body);
  const result = await query('SELECT id,email,display_name,password_hash FROM users WHERE email=$1', [normalizeEmail(body.email)]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(body.password, user.password_hash))) return reply.code(401).send({ error: 'Invalid email or password.' });
  const token = await createSession(user.id);
  setSession(reply, token);
  reply.send({ user: { id: user.id, email: user.email, display_name: user.display_name } });
});
app.post('/api/auth/logout', async (request, reply) => {
  const token = request.cookies[sessionName];
  if (token) await query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]);
  clearSession(reply);
  reply.code(204).send();
});
app.get('/api/auth/me', async request => ({ user: await currentUser(request) }));

app.get('/api/invitations/:token', async (request, reply) => {
  const token = z.string().min(20).max(200).parse(request.params.token);
  const result = await query(`SELECT i.email,i.role,i.expires_at,w.name AS wedding_name
    FROM invitations i JOIN weddings w ON w.id=i.wedding_id
    WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`, [hashToken(token)]);
  if (!result.rows[0]) return reply.code(404).send({ error: 'This invitation is invalid or has expired.' });
  return { invitation: result.rows[0] };
});
app.post('/api/invitations/accept', async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const body = z.object({ token: z.string().min(20).max(200) }).parse(request.body);
  const invitation = await withTransaction(client => acceptInvitation(client, user, body.token));
  return { weddingId: invitation.wedding_id, role: invitation.role };
});

app.get('/api/weddings', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const result = await query(`SELECT w.id,w.name,w.wedding_date,w.location,m.role
    FROM weddings w JOIN memberships m ON m.wedding_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at`, [user.id]);
  return { weddings: result.rows };
});
app.patch('/api/weddings/:weddingId', async (request, reply) => {
  const user = await ownerUser(request, reply); if (!user) return;
  const { weddingId } = request.params;
  const body = z.object({ name:z.string().trim().min(1).max(160).optional(), weddingDate:z.string().date().nullable().optional(), location:z.string().trim().max(160).nullable().optional() }).parse(request.body);
  const fields = { name:body.name, wedding_date:body.weddingDate, location:body.location };
  const entries = Object.entries(fields).filter(([,value]) => value !== undefined);
  if (!entries.length) return reply.code(400).send({ error:'No changes supplied.' });
  const wedding = await withTransaction(async client => {
    const values=[weddingId];
    const sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+2}`;});
    const result=await client.query(`UPDATE weddings SET ${sets.join(',')},updated_at=now() WHERE id=$1 RETURNING id,name,wedding_date,location`,values);
    if (!result.rows[0]) throw httpError('Wedding workspace not found.',404);
    await audit(client,weddingId,user.id,'wedding',weddingId,'updated',{fields:entries.map(([column])=>column)});
    return result.rows[0];
  });
  return { wedding };
});

app.get('/api/weddings/:weddingId/collaboration', async (request, reply) => {
  const user = await ownerUser(request, reply); if (!user) return;
  const { weddingId } = request.params;
  const [members, invitations] = await Promise.all([
    query(`SELECT u.id,u.email,u.display_name,m.role,m.created_at
      FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.wedding_id=$1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'contributor' THEN 2 ELSE 3 END, u.display_name`, [weddingId]),
    query(`SELECT id,email,role,expires_at,created_at FROM invitations
      WHERE wedding_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [weddingId])
  ]);
  return { members: members.rows, invitations: invitations.rows };
});
app.get('/api/weddings/:weddingId/members', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { weddingId } = request.params;
  await requireMembership(user.id, weddingId, allRoles);
  const members = await query(`SELECT u.id,u.email,u.display_name,m.role
    FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.wedding_id=$1 ORDER BY u.display_name,u.email`, [weddingId]);
  return { members: members.rows };
});
app.get('/api/weddings/:weddingId/activity', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,allRoles);
  const result=await query(`SELECT a.id,a.entity_type,a.entity_id,a.action,a.details,a.created_at,u.display_name AS actor_name
    FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id
    WHERE a.wedding_id=$1 ORDER BY a.created_at DESC LIMIT 100`,[weddingId]);
  return { events:result.rows };
});
app.get('/api/weddings/:weddingId/finance/summary', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const [budget,expenses,payments,reimbursements]=await Promise.all([
    query(`SELECT COALESCE(SUM(planned_amount),0)::numeric AS planned FROM budget_categories WHERE wedding_id=$1 AND archived_at IS NULL`,[weddingId]),
    query(`SELECT COALESCE(SUM(committed),0)::numeric AS committed,
      COALESCE(SUM(CASE WHEN stage='estimated' THEN committed ELSE 0 END),0)::numeric AS estimated
      FROM expenses WHERE wedding_id=$1 AND archived_at IS NULL AND stage NOT IN ('cancelled','refunded')`,[weddingId]),
    query(`SELECT COALESCE(SUM(amount),0)::numeric AS paid FROM payments WHERE wedding_id=$1 AND archived_at IS NULL`,[weddingId]),
    query(`SELECT COALESCE(SUM(s.amount) FILTER (WHERE s.settled_at IS NULL),0)::numeric AS reimbursement_owed
      FROM payment_splits s JOIN payments p ON p.id=s.payment_id WHERE p.wedding_id=$1 AND p.archived_at IS NULL`,[weddingId])
  ]);
  const planned=Number(budget.rows[0].planned),committed=Number(expenses.rows[0].committed),paid=Number(payments.rows[0].paid);
  return { summary:{planned,estimated:Number(expenses.rows[0].estimated),committed,paid,stillOwed:Math.max(0,committed-paid),remainingBudget:planned-committed,reimbursementOwed:Number(reimbursements.rows[0].reimbursement_owed)} };
});
app.get('/api/weddings/:weddingId/budget-categories', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query('SELECT id,name,planned_amount,created_at,updated_at FROM budget_categories WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY name',[weddingId]);
  return { categories:result.rows };
});
app.post('/api/weddings/:weddingId/budget-categories', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({name:z.string().trim().min(1).max(100),plannedAmount:z.number().nonnegative().optional()}).parse(request.body);
  const category=await withTransaction(async client=>{const result=await client.query(`INSERT INTO budget_categories (wedding_id,name,planned_amount,created_by,updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING id,name,planned_amount,created_at,updated_at`,[weddingId,body.name,body.plannedAmount||0,user.id]);await audit(client,weddingId,user.id,'budget_category',result.rows[0].id,'created');return result.rows[0];});
  reply.code(201).send({category});
});
app.get('/api/weddings/:weddingId/expenses', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query(`SELECT e.*,c.name AS budget_category_name,v.name AS vendor_name,
    COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.expense_id=e.id AND p.archived_at IS NULL),0)::numeric AS payments_total
    FROM expenses e LEFT JOIN budget_categories c ON c.id=e.budget_category_id LEFT JOIN vendors v ON v.id=e.vendor_id
    WHERE e.wedding_id=$1 AND e.archived_at IS NULL ORDER BY e.due_date NULLS LAST,e.created_at DESC`,[weddingId]);
  return { expenses:result.rows };
});
app.post('/api/weddings/:weddingId/expenses', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({name:z.string().trim().min(1).max(200),category:z.string().max(80).optional(),description:z.string().max(5000).nullable().optional(),committed:z.number().nonnegative().optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),stage:z.enum(['estimated','quoted','committed','partially_paid','paid','refunded','cancelled']).optional(),dueDate:z.string().date().nullable().optional(),budgetCategoryId:z.string().uuid().nullable().optional(),vendorId:z.string().uuid().nullable().optional()}).parse(request.body);
  const expense=await withTransaction(async client=>{const result=await client.query(`INSERT INTO expenses (wedding_id,name,category,description,committed,currency,stage,due_date,budget_category_id,vendor_id,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,[weddingId,body.name,body.category||'Other',body.description||null,body.committed||0,body.currency||'USD',body.stage||'estimated',body.dueDate||null,body.budgetCategoryId||null,body.vendorId||null,user.id]);await audit(client,weddingId,user.id,'expense',result.rows[0].id,'created');return result.rows[0];});
  reply.code(201).send({expense});
});
app.patch('/api/weddings/:weddingId/expenses/:expenseId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,expenseId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({name:z.string().trim().min(1).max(200).optional(),category:z.string().max(80).optional(),description:z.string().max(5000).nullable().optional(),committed:z.number().nonnegative().optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),stage:z.enum(['estimated','quoted','committed','partially_paid','paid','refunded','cancelled']).optional(),dueDate:z.string().date().nullable().optional(),budgetCategoryId:z.string().uuid().nullable().optional(),vendorId:z.string().uuid().nullable().optional()}).parse(request.body);
  const fields={name:body.name,category:body.category,description:body.description,committed:body.committed,currency:body.currency,stage:body.stage,due_date:body.dueDate,budget_category_id:body.budgetCategoryId,vendor_id:body.vendorId};const entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)return reply.code(400).send({error:'No changes supplied.'});
  const expense=await withTransaction(async client=>{const values=[weddingId,expenseId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await client.query(`UPDATE expenses SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Expense not found.',404);await audit(client,weddingId,user.id,'expense',expenseId,'updated',{fields:entries.map(([column])=>column)});return result.rows[0];});
  return {expense};
});
app.delete('/api/weddings/:weddingId/expenses/:expenseId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,expenseId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE expenses SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,expenseId,user.id]);if(!result.rows[0])throw httpError('Expense not found.',404);await audit(client,weddingId,user.id,'expense',expenseId,'archived');});
  reply.code(204).send();
});
app.get('/api/weddings/:weddingId/payments', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query(`SELECT p.*,e.name AS expense_name,v.name AS vendor_name,u.display_name AS payer_name,
    COALESCE((SELECT SUM(s.amount) FROM payment_splits s WHERE s.payment_id=p.id AND s.settled_at IS NULL),0)::numeric AS reimbursement_owed
    FROM payments p LEFT JOIN expenses e ON e.id=p.expense_id LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN users u ON u.id=p.payer_user_id
    WHERE p.wedding_id=$1 AND p.archived_at IS NULL ORDER BY p.paid_on DESC,p.created_at DESC`,[weddingId]);
  return {payments:result.rows};
});
app.post('/api/weddings/:weddingId/payments', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({expenseId:z.string().uuid().nullable().optional(),vendorId:z.string().uuid().nullable().optional(),payerUserId:z.string().uuid().nullable().optional(),payerLabel:z.string().max(100).nullable().optional(),amount:z.number().positive(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),paidOn:z.string().date().optional(),method:z.string().max(100).nullable().optional(),notes:z.string().max(5000).nullable().optional(),splits:z.array(z.object({owedByUserId:z.string().uuid().nullable().optional(),owedByLabel:z.string().max(100).nullable().optional(),amount:z.number().positive()})).max(20).optional()}).parse(request.body);
  if ((body.splits||[]).reduce((sum,split)=>sum+split.amount,0) > body.amount) throw httpError('Repayment splits cannot exceed the payment amount.');
  const payment=await withTransaction(async client=>{const payer=await resolveFinanceMember(client,weddingId,body.payerUserId,body.payerLabel,'payer');const result=await client.query(`INSERT INTO payments (wedding_id,expense_id,vendor_id,payer_user_id,payer_label,amount,currency,paid_on,method,notes,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,[weddingId,body.expenseId||null,body.vendorId||null,payer.userId,payer.label,body.amount,body.currency||'USD',body.paidOn||new Date().toISOString().slice(0,10),body.method||null,body.notes||null,user.id]);for(const split of body.splits||[]){const owingMember=await resolveFinanceMember(client,weddingId,split.owedByUserId,split.owedByLabel,'person who owes');await client.query('INSERT INTO payment_splits (payment_id,owed_by_user_id,owed_by_label,amount) VALUES ($1,$2,$3,$4)',[result.rows[0].id,owingMember.userId,owingMember.label,split.amount]);}await audit(client,weddingId,user.id,'payment',result.rows[0].id,'created',{amount:body.amount,splitCount:(body.splits||[]).length});return result.rows[0];});
  reply.code(201).send({payment});
});
app.delete('/api/weddings/:weddingId/payments/:paymentId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,paymentId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE payments SET archived_at=now(),updated_by=$3,updated_at=now() WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL RETURNING id',[paymentId,weddingId,user.id]);if(!result.rows[0])throw httpError('Payment not found.',404);await audit(client,weddingId,user.id,'payment',paymentId,'archived');});
  reply.code(204).send();
});
app.get('/api/weddings/:weddingId/vendors', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query(`SELECT v.*,COALESCE((SELECT SUM(e.committed) FROM expenses e WHERE e.vendor_id=v.id AND e.archived_at IS NULL AND e.stage NOT IN ('cancelled','refunded')),0)::numeric AS committed_total,
    COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.vendor_id=v.id AND p.archived_at IS NULL),0)::numeric AS paid_total
    FROM vendors v WHERE v.wedding_id=$1 AND v.archived_at IS NULL ORDER BY v.name`,[weddingId]);
  return {vendors:result.rows};
});
app.post('/api/weddings/:weddingId/vendors', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({name:z.string().trim().min(1).max(200),category:z.string().max(80).optional(),status:z.enum(['researching','contacted','quoted','shortlisted','booked','declined','cancelled']).optional(),contact:z.string().max(1000).nullable().optional(),notes:z.string().max(5000).nullable().optional(),terms:z.string().max(5000).nullable().optional()}).parse(request.body);
  const vendor=await withTransaction(async client=>{const result=await client.query(`INSERT INTO vendors (wedding_id,name,category,status,contact,notes,terms,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,[weddingId,body.name,body.category||'Other',body.status||'researching',body.contact||null,body.notes||null,body.terms||null,user.id]);await audit(client,weddingId,user.id,'vendor',result.rows[0].id,'created');return result.rows[0];});
  reply.code(201).send({vendor});
});
app.patch('/api/weddings/:weddingId/vendors/:vendorId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,vendorId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({name:z.string().trim().min(1).max(200).optional(),category:z.string().max(80).optional(),status:z.enum(['researching','contacted','quoted','shortlisted','booked','declined','cancelled']).optional(),contact:z.string().max(1000).nullable().optional(),notes:z.string().max(5000).nullable().optional(),terms:z.string().max(5000).nullable().optional()}).parse(request.body);
  const fields={name:body.name,category:body.category,status:body.status,contact:body.contact,notes:body.notes,terms:body.terms},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)return reply.code(400).send({error:'No changes supplied.'});
  const vendor=await withTransaction(async client=>{const values=[weddingId,vendorId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await client.query(`UPDATE vendors SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Vendor not found.',404);await audit(client,weddingId,user.id,'vendor',vendorId,'updated',{fields:entries.map(([column])=>column)});return result.rows[0];});
  return {vendor};
});
app.delete('/api/weddings/:weddingId/vendors/:vendorId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,vendorId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE vendors SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,vendorId,user.id]);if(!result.rows[0])throw httpError('Vendor not found.',404);await audit(client,weddingId,user.id,'vendor',vendorId,'archived');});
  reply.code(204).send();
});
app.post('/api/weddings/:weddingId/invitations', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request, reply) => {
  const user = await ownerUser(request, reply); if (!user) return;
  const { weddingId } = request.params;
  const body = z.object({ email: z.string().email(), role: z.enum(invitationRoles), expiresInDays: z.number().int().min(1).max(30).optional() }).parse(request.body);
  const email = normalizeEmail(body.email);
  const token = invitationToken();
  const invitation = await withTransaction(async client => {
    const member = await client.query(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.wedding_id=$1 AND u.email=$2`, [weddingId, email]);
    if (member.rows[0]) throw httpError('This person already has access to the wedding workspace.', 409);
    await client.query(`UPDATE invitations SET revoked_at=now(), revoked_by=$2
      WHERE wedding_id=$1 AND email=$3 AND accepted_at IS NULL AND revoked_at IS NULL`, [weddingId, user.id, email]);
    const result = await client.query(`INSERT INTO invitations (wedding_id,email,role,token_hash,invited_by,expires_at)
      VALUES ($1,$2,$3,$4,$5,now() + ($6 * interval '1 day')) RETURNING id,email,role,expires_at,created_at`, [weddingId, email, body.role, hashToken(token), user.id, body.expiresInDays || 14]);
    await audit(client, weddingId, user.id, 'invitation', result.rows[0].id, 'created', { email, role: body.role });
    return result.rows[0];
  });
  reply.code(201).send({ invitation, token });
});
app.delete('/api/weddings/:weddingId/invitations/:invitationId', async (request, reply) => {
  const user = await ownerUser(request, reply); if (!user) return;
  const { weddingId, invitationId } = request.params;
  await withTransaction(async client => {
    const result = await client.query(`UPDATE invitations SET revoked_at=now(), revoked_by=$3
      WHERE id=$1 AND wedding_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`, [invitationId, weddingId, user.id]);
    if (!result.rows[0]) throw httpError('Invitation not found.', 404);
    await audit(client, weddingId, user.id, 'invitation', invitationId, 'revoked');
  });
  reply.code(204).send();
});
app.patch('/api/weddings/:weddingId/members/:memberId', async (request, reply) => {
  const user = await ownerUser(request, reply); if (!user) return;
  const { weddingId, memberId } = request.params;
  const body = z.object({ role: z.enum(allRoles) }).parse(request.body);
  const membership = await withTransaction(async client => {
    const current = await client.query('SELECT role FROM memberships WHERE wedding_id=$1 AND user_id=$2 FOR UPDATE', [weddingId, memberId]);
    if (!current.rows[0]) throw httpError('Member not found.', 404);
    if (current.rows[0].role === 'owner' && body.role !== 'owner') {
      const owners = await client.query("SELECT count(*)::int AS count FROM memberships WHERE wedding_id=$1 AND role='owner'", [weddingId]);
      if (owners.rows[0].count <= 1) throw httpError('A wedding workspace must always have at least one owner.', 409);
    }
    const updated = await client.query('UPDATE memberships SET role=$3 WHERE wedding_id=$1 AND user_id=$2 RETURNING role', [weddingId, memberId, body.role]);
    await audit(client, weddingId, user.id, 'membership', memberId, 'role_updated', { role: body.role });
    return updated.rows[0];
  });
  return { membership };
});
app.delete('/api/weddings/:weddingId/members/:memberId', async (request, reply) => {
  const user = await ownerUser(request, reply); if (!user) return;
  const { weddingId, memberId } = request.params;
  if (user.id === memberId) return reply.code(409).send({ error: 'Owners cannot remove themselves. Ask another owner to remove you after transferring ownership.' });
  await withTransaction(async client => {
    const current = await client.query('SELECT role FROM memberships WHERE wedding_id=$1 AND user_id=$2 FOR UPDATE', [weddingId, memberId]);
    if (!current.rows[0]) throw httpError('Member not found.', 404);
    if (current.rows[0].role === 'owner') {
      const owners = await client.query("SELECT count(*)::int AS count FROM memberships WHERE wedding_id=$1 AND role='owner'", [weddingId]);
      if (owners.rows[0].count <= 1) throw httpError('A wedding workspace must always have at least one owner.', 409);
    }
    await client.query('DELETE FROM memberships WHERE wedding_id=$1 AND user_id=$2', [weddingId, memberId]);
    await audit(client, weddingId, user.id, 'membership', memberId, 'removed');
  });
  reply.code(204).send();
});

app.get('/api/weddings/:weddingId/tasks', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { weddingId } = request.params;
  await requireMembership(user.id, weddingId, allRoles);
  const result = await query(`SELECT t.*, u.display_name AS assignee_name FROM tasks t
    LEFT JOIN users u ON u.id=t.assignee_user_id
    WHERE t.wedding_id=$1 AND t.archived_at IS NULL ORDER BY t.status,t.position,t.created_at`, [weddingId]);
  const comments = await query(`SELECT c.*, u.display_name AS author_name FROM task_comments c
    JOIN users u ON u.id=c.created_by WHERE c.wedding_id=$1 AND c.archived_at IS NULL ORDER BY c.created_at`, [weddingId]);
  const commentsByTask = new Map();
  for (const comment of comments.rows) commentsByTask.set(comment.task_id, [...(commentsByTask.get(comment.task_id) || []), comment]);
  const attachments = await query('SELECT id,task_id,original_name,content_type,byte_size,created_at FROM task_attachments WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY created_at',[weddingId]);
  const attachmentsByTask = new Map();
  for (const attachment of attachments.rows) attachmentsByTask.set(attachment.task_id,[...(attachmentsByTask.get(attachment.task_id)||[]),attachment]);
  return { tasks: result.rows.map(task => ({ ...task, comments: commentsByTask.get(task.id) || [], attachments: attachmentsByTask.get(task.id) || [] })) };
});
app.post('/api/weddings/:weddingId/tasks', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { weddingId } = request.params;
  await requireMembership(user.id, weddingId, ['owner', 'editor', 'contributor']);
  const body = z.object({ title:z.string().min(1).max(250), category:z.string().max(80).optional(), priority:z.enum(['Low','Medium','High']).optional(), assignee:z.string().max(100).nullable().optional(), assigneeUserId:z.string().uuid().nullable().optional(), notes:z.string().max(5000).nullable().optional(), linkedVendor:z.string().max(160).nullable().optional(), dueDate:z.string().date().nullable().optional(), status:z.enum(['todo','progress','done']).optional(), position:z.number().int().nonnegative().optional() }).parse(request.body);
  const task = await withTransaction(async client => {
    const assignee = await resolveAssignee(client, weddingId, body.assigneeUserId);
    const position = body.position ?? (await client.query('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE wedding_id=$1 AND status=$2 AND archived_at IS NULL', [weddingId, body.status || 'todo'])).rows[0].position;
    const result = await client.query(`INSERT INTO tasks (wedding_id,title,category,priority,assignee,assignee_user_id,notes,linked_vendor,due_date,status,position,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`, [weddingId,body.title,body.category||'Other',body.priority||'Medium',assignee.name,assignee.id,body.notes||null,body.linkedVendor||null,body.dueDate||null,body.status||'todo',position,user.id]);
    await audit(client,weddingId,user.id,'task',result.rows[0].id,'created');
    return result.rows[0];
  });
  reply.code(201).send({ task });
});
app.post('/api/weddings/:weddingId/tasks/import', async (request, reply) => {
  const user = await ownerUser(request, reply); if (!user) return;
  const { weddingId } = request.params;
  const body = z.object({ tasks:z.array(z.object({
    title:z.string().trim().min(1).max(250), category:z.string().max(80).optional(), priority:z.enum(['Low','Medium','High']).optional(),
    assigneeUserId:z.string().uuid().nullable().optional(), notes:z.string().max(5000).nullable().optional(), linkedVendor:z.string().max(160).nullable().optional(),
    dueDate:z.string().date().nullable().optional(), status:z.enum(['todo','progress','done']).optional()
  })).min(1).max(500) }).parse(request.body);
  const imported = await withTransaction(async client => {
    const positions = new Map();
    for (const status of ['todo','progress','done']) {
      const result = await client.query('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE wedding_id=$1 AND status=$2 AND archived_at IS NULL',[weddingId,status]);
      positions.set(status, Number(result.rows[0].position));
    }
    const records=[];
    for (const item of body.tasks) {
      const status=item.status||'todo', assignee=await resolveAssignee(client,weddingId,item.assigneeUserId);
      const result=await client.query(`INSERT INTO tasks (wedding_id,title,category,priority,assignee,assignee_user_id,notes,linked_vendor,due_date,status,position,created_by,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,[weddingId,item.title,item.category||'Other',item.priority||'Medium',assignee.name,assignee.id,item.notes||null,item.linkedVendor||null,item.dueDate||null,status,positions.get(status),user.id]);
      positions.set(status,positions.get(status)+1); records.push(result.rows[0]);
    }
    await audit(client,weddingId,user.id,'task',null,'imported',{count:records.length});
    return records;
  });
  reply.code(201).send({ imported:imported.length });
});
app.put('/api/weddings/:weddingId/tasks/order', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { weddingId } = request.params;
  await requireMembership(user.id, weddingId, ['owner','editor','contributor']);
  const body = z.object({ tasks: z.array(z.object({ id:z.string().uuid(), status:z.enum(['todo','progress','done']), position:z.number().int().nonnegative() })).max(500) }).parse(request.body);
  await withTransaction(async client => {
    for (const task of body.tasks) {
      const result = await client.query('UPDATE tasks SET status=$3,position=$4,updated_by=$5,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL', [weddingId, task.id, task.status, task.position, user.id]);
      if (!result.rowCount) throw httpError('Task not found.', 404);
    }
    await audit(client,weddingId,user.id,'task',null,'reordered',{count:body.tasks.length});
  });
  reply.code(204).send();
});
app.post('/api/weddings/:weddingId/tasks/:taskId/comments', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { weddingId, taskId } = request.params;
  await requireMembership(user.id, weddingId, ['owner','editor','contributor']);
  const body = z.object({ body:z.string().trim().min(1).max(5000) }).parse(request.body);
  const comment = await withTransaction(async client => {
    const exists = await client.query('SELECT id FROM tasks WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL', [taskId,weddingId]);
    if (!exists.rows[0]) throw httpError('Task not found.', 404);
    const result = await client.query(`INSERT INTO task_comments (task_id,wedding_id,body,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$4) RETURNING *`,[taskId,weddingId,body.body,user.id]);
    await audit(client,weddingId,user.id,'task_comment',result.rows[0].id,'created',{taskId});
    return { ...result.rows[0], author_name:user.display_name };
  });
  reply.code(201).send({ comment });
});
app.patch('/api/weddings/:weddingId/tasks/:taskId/comments/:commentId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { weddingId, taskId, commentId } = request.params;
  const membership = await requireMembership(user.id, weddingId, ['owner','editor','contributor']);
  const body = z.object({ body:z.string().trim().min(1).max(5000) }).parse(request.body);
  const comment = await withTransaction(async client => {
    const current = await client.query('SELECT created_by FROM task_comments WHERE id=$1 AND task_id=$2 AND wedding_id=$3 AND archived_at IS NULL FOR UPDATE',[commentId,taskId,weddingId]);
    if (!current.rows[0]) throw httpError('Comment not found.',404);
    if (membership.role !== 'owner' && current.rows[0].created_by !== user.id) throw httpError('Only the author or an owner can edit this comment.',403);
    const result = await client.query('UPDATE task_comments SET body=$4,updated_by=$5,updated_at=now() WHERE id=$1 AND task_id=$2 AND wedding_id=$3 RETURNING *',[commentId,taskId,weddingId,body.body,user.id]);
    await audit(client,weddingId,user.id,'task_comment',commentId,'updated',{taskId});
    return { ...result.rows[0], author_name:user.display_name };
  });
  return { comment };
});
app.delete('/api/weddings/:weddingId/tasks/:taskId/comments/:commentId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { weddingId, taskId, commentId } = request.params;
  const membership = await requireMembership(user.id, weddingId, ['owner','editor','contributor']);
  await withTransaction(async client => {
    const current = await client.query('SELECT created_by FROM task_comments WHERE id=$1 AND task_id=$2 AND wedding_id=$3 AND archived_at IS NULL FOR UPDATE',[commentId,taskId,weddingId]);
    if (!current.rows[0]) throw httpError('Comment not found.',404);
    if (membership.role !== 'owner' && current.rows[0].created_by !== user.id) throw httpError('Only the author or an owner can delete this comment.',403);
    await client.query('UPDATE task_comments SET archived_at=now(),updated_by=$4,updated_at=now() WHERE id=$1 AND task_id=$2 AND wedding_id=$3',[commentId,taskId,weddingId,user.id]);
    await audit(client,weddingId,user.id,'task_comment',commentId,'archived',{taskId});
  });
  reply.code(204).send();
});
app.get('/api/weddings/:weddingId/tasks/:taskId/attachments', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,taskId}=request.params; await requireMembership(user.id,weddingId,allRoles);
  const result=await query('SELECT id,original_name,content_type,byte_size,created_at FROM task_attachments WHERE wedding_id=$1 AND task_id=$2 AND archived_at IS NULL ORDER BY created_at',[weddingId,taskId]);
  return { attachments:result.rows };
});
app.post('/api/weddings/:weddingId/tasks/:taskId/attachments', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,taskId}=request.params; await requireMembership(user.id,weddingId,['owner','editor','contributor']);
  const task=await query('SELECT id FROM tasks WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL',[taskId,weddingId]);
  if(!task.rows[0]) throw httpError('Task not found.',404);
  const file=await request.file(); if(!file) throw httpError('Choose one file to upload.');
  const buffer=await file.toBuffer();
  const id=crypto.randomUUID(), originalName=path.basename(file.filename || 'attachment'), storageKey=`${id}-${originalName.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
  await mkdir(uploadsDirectory,{recursive:true}); await writeFile(path.join(uploadsDirectory,storageKey),buffer);
  const attachment=await withTransaction(async client=>{
    const result=await client.query(`INSERT INTO task_attachments (id,task_id,wedding_id,original_name,storage_key,content_type,byte_size,checksum_sha256,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,original_name,content_type,byte_size,created_at`,[id,taskId,weddingId,originalName,storageKey,file.mimetype||'application/octet-stream',buffer.length,crypto.createHash('sha256').update(buffer).digest('hex'),user.id]);
    await audit(client,weddingId,user.id,'task_attachment',id,'created',{taskId,originalName}); return result.rows[0];
  });
  reply.code(201).send({attachment});
});
app.get('/api/weddings/:weddingId/tasks/:taskId/attachments/:attachmentId/download', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,taskId,attachmentId}=request.params; await requireMembership(user.id,weddingId,allRoles);
  const result=await query('SELECT original_name,storage_key,content_type FROM task_attachments WHERE id=$1 AND task_id=$2 AND wedding_id=$3 AND archived_at IS NULL',[attachmentId,taskId,weddingId]);
  if(!result.rows[0]) throw httpError('Attachment not found.',404); const attachment=result.rows[0];
  reply.header('Content-Disposition',`inline; filename="${attachment.original_name.replaceAll('"','')}"`).type(attachment.content_type); return reply.send(createReadStream(path.join(uploadsDirectory,attachment.storage_key)));
});
app.delete('/api/weddings/:weddingId/tasks/:taskId/attachments/:attachmentId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,taskId,attachmentId}=request.params; await requireMembership(user.id,weddingId,['owner','editor','contributor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE task_attachments SET archived_at=now() WHERE id=$1 AND task_id=$2 AND wedding_id=$3 AND archived_at IS NULL RETURNING id',[attachmentId,taskId,weddingId]); if(!result.rows[0]) throw httpError('Attachment not found.',404); await audit(client,weddingId,user.id,'task_attachment',attachmentId,'archived',{taskId});});
  reply.code(204).send();
});
app.patch('/api/weddings/:weddingId/tasks/:taskId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { weddingId, taskId } = request.params;
  await requireMembership(user.id, weddingId, ['owner','editor','contributor']);
  const body = z.object({ title:z.string().min(1).max(250).optional(), category:z.string().max(80).optional(), priority:z.enum(['Low','Medium','High']).optional(), assignee:z.string().max(100).nullable().optional(), assigneeUserId:z.string().uuid().nullable().optional(), notes:z.string().max(5000).nullable().optional(), linkedVendor:z.string().max(160).nullable().optional(), dueDate:z.string().date().nullable().optional(), status:z.enum(['todo','progress','done']).optional(), position:z.number().int().nonnegative().optional() }).parse(request.body);
  const fields={title:body.title,category:body.category,priority:body.priority,assignee:body.assignee,notes:body.notes,linked_vendor:body.linkedVendor,due_date:body.dueDate,status:body.status,position:body.position};
  const task=await withTransaction(async client=>{
    if (body.assigneeUserId !== undefined) {
      const assignee = await resolveAssignee(client, weddingId, body.assigneeUserId);
      fields.assignee = assignee.name;
      fields.assignee_user_id = assignee.id;
    }
    const entries=Object.entries(fields).filter(([,value])=>value!==undefined);
    if(!entries.length) throw httpError('No changes supplied.');
    const values=[weddingId,taskId];
    const sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});
    values.push(user.id);
    const result=await client.query(`UPDATE tasks SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);
    if(!result.rows[0]) throw httpError('Task not found.',404);
    await audit(client,weddingId,user.id,'task',taskId,'updated',{fields:entries.map(([column])=>column)});
    return result.rows[0];
  });
  return {task};
});
app.delete('/api/weddings/:weddingId/tasks/:taskId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,taskId}=request.params;
  await requireMembership(user.id,weddingId,['owner','editor','contributor']);
  await withTransaction(async client=>{
    const result=await client.query('UPDATE tasks SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,taskId,user.id]);
    if(!result.rows[0]) throw httpError('Task not found.',404);
    await audit(client,weddingId,user.id,'task',taskId,'archived');
  });
  reply.code(204).send();
});

app.setErrorHandler((error, request, reply) => {
  if (error.name === 'ZodError') return reply.code(400).send({ error: 'Invalid request.', details: error.issues });
  request.log.error(error);
  reply.code(error.statusCode || 500).send({ error: error.statusCode ? error.message : 'Request failed.' });
});
app.addHook('onClose', async () => pool.end());
await app.listen({ port: Number(process.env.PORT || 3000), host: process.env.HOST || '0.0.0.0' });
