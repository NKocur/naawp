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
// The __Host- prefix asks browsers to enforce a host-only, Secure, root-path
// cookie in production. Keep the local-development name unprefixed so HTTP
// localhost development continues to work.
const sessionName = isProduction ? '__Host-ever_after_session' : 'ever_after_session';
const allRoles = ['owner', 'editor', 'contributor', 'viewer'];
const invitationRoles = ['owner', 'editor', 'contributor', 'viewer'];
const uploadsDirectory = process.env.UPLOADS_DIRECTORY || '/app/uploads';
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

await app.register(cookie);
await app.register(rateLimit, { global: true, max: 200, timeWindow: '1 minute' });
await app.register(multipart, { limits: { files: 1, fileSize: 50 * 1024 * 1024 } });
app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/') || !unsafeMethods.has(request.method)) return;
  // SameSite=Strict is already the primary browser CSRF barrier. These checks
  // add defense in depth for modern browsers without requiring a token in each
  // JSON request. Command-line/API clients without an Origin header still work.
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    return reply.code(403).send({ error: 'Cross-site write requests are not allowed.' });
  }
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).host.toLowerCase() !== String(request.headers.host || '').toLowerCase()) {
      return reply.code(403).send({ error: 'Cross-site write requests are not allowed.' });
    }
  } catch {
    return reply.code(403).send({ error: 'Cross-site write requests are not allowed.' });
  }
});

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
const financeRecordSources = {
  budgetCategory: { table: 'budget_categories', label: 'budget category' },
  vendor: { table: 'vendors', label: 'vendor' },
  expense: { table: 'expenses', label: 'expense' }
};
async function requireActiveFinanceRecord(client, weddingId, recordId, type) {
  if (!recordId) return;
  const source = financeRecordSources[type];
  const result = await client.query(`SELECT id FROM ${source.table} WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL`, [recordId, weddingId]);
  if (!result.rows[0]) throw httpError(`The selected ${source.label} does not belong to this workspace.`, 400);
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
      // Serialize the one-time initial-workspace check so two simultaneous
      // registrations cannot both create an owner workspace.
      await client.query('SELECT pg_advisory_xact_lock(81420731)');
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
  const result = await query(`SELECT w.id,w.name,w.wedding_date,w.rsvp_deadline,w.location,w.budget_total,m.role
    FROM weddings w JOIN memberships m ON m.wedding_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at`, [user.id]);
  return { weddings: result.rows };
});
app.patch('/api/weddings/:weddingId', async (request, reply) => {
  const user = await ownerUser(request, reply); if (!user) return;
  const { weddingId } = request.params;
  const body = z.object({ name:z.string().trim().min(1).max(160).optional(), weddingDate:z.string().date().nullable().optional(), rsvpDeadline:z.string().date().nullable().optional(), location:z.string().trim().max(160).nullable().optional(), budgetTotal:z.number().nonnegative().optional() }).parse(request.body);
  const fields = { name:body.name, wedding_date:body.weddingDate, rsvp_deadline:body.rsvpDeadline, location:body.location, budget_total:body.budgetTotal };
  const entries = Object.entries(fields).filter(([,value]) => value !== undefined);
  if (!entries.length) return reply.code(400).send({ error:'No changes supplied.' });
  const wedding = await withTransaction(async client => {
    const values=[weddingId];
    const sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+2}`;});
    const result=await client.query(`UPDATE weddings SET ${sets.join(',')},updated_at=now() WHERE id=$1 RETURNING id,name,wedding_date,rsvp_deadline,location,budget_total`,values);
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
  const members = await query(`SELECT u.id,u.display_name,m.role
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
    query(`SELECT w.budget_total,COALESCE(SUM(b.planned_amount),0)::numeric AS planned FROM weddings w LEFT JOIN budget_categories b ON b.wedding_id=w.id AND b.archived_at IS NULL WHERE w.id=$1 GROUP BY w.id,w.budget_total`,[weddingId]),
    query(`SELECT COALESCE(SUM(committed),0)::numeric AS committed,
      COALESCE(SUM(CASE WHEN stage='estimated' THEN committed ELSE 0 END),0)::numeric AS estimated
      FROM expenses WHERE wedding_id=$1 AND archived_at IS NULL AND stage NOT IN ('cancelled','refunded')`,[weddingId]),
    query(`SELECT COALESCE(SUM(amount),0)::numeric AS paid FROM payments WHERE wedding_id=$1 AND archived_at IS NULL`,[weddingId]),
    query(`SELECT COALESCE(SUM(s.amount) FILTER (WHERE s.settled_at IS NULL),0)::numeric AS reimbursement_owed
      FROM payment_splits s JOIN payments p ON p.id=s.payment_id WHERE p.wedding_id=$1 AND p.archived_at IS NULL`,[weddingId])
  ]);
  const planned=Number(budget.rows[0].planned),budgetTotal=Number(budget.rows[0].budget_total),committed=Number(expenses.rows[0].committed),paid=Number(payments.rows[0].paid);
  return { summary:{budgetTotal,planned,estimated:Number(expenses.rows[0].estimated),committed,paid,stillOwed:Math.max(0,committed-paid),remainingBudget:budgetTotal-committed,reimbursementOwed:Number(reimbursements.rows[0].reimbursement_owed)} };
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
app.patch('/api/weddings/:weddingId/budget-categories/:categoryId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,categoryId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({name:z.string().trim().min(1).max(100).optional(),plannedAmount:z.number().nonnegative().optional()}).parse(request.body);
  const fields={name:body.name,planned_amount:body.plannedAmount};const entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');
  const values=[weddingId,categoryId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);
  const result=await query(`UPDATE budget_categories SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id,name,planned_amount,created_at,updated_at`,values);if(!result.rows[0])throw httpError('Budget category not found.',404);await query(`INSERT INTO audit_events (wedding_id,actor_id,entity_type,entity_id,action,details) VALUES ($1,$2,'budget_category',$3,'updated',$4)`,[weddingId,user.id,categoryId,JSON.stringify({fields:entries.map(([column])=>column)})]);return {category:result.rows[0]};
});
app.delete('/api/weddings/:weddingId/budget-categories/:categoryId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,categoryId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query(`UPDATE budget_categories SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id`,[weddingId,categoryId,user.id]);if(!result.rows[0])throw httpError('Budget category not found.',404);await query(`INSERT INTO audit_events (wedding_id,actor_id,entity_type,entity_id,action) VALUES ($1,$2,'budget_category',$3,'archived')`,[weddingId,user.id,categoryId]);reply.code(204).send();
});
app.get('/api/weddings/:weddingId/expenses', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query(`SELECT e.*,c.name AS budget_category_name,v.name AS vendor_name,
    COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.expense_id=e.id AND p.archived_at IS NULL),0)::numeric AS payments_total,
    COALESCE((SELECT json_agg(json_build_object('id',a.id,'originalName',a.original_name,'contentType',a.content_type,'byteSize',a.byte_size,'createdAt',a.created_at) ORDER BY a.created_at) FROM expense_quote_attachments a WHERE a.expense_id=e.id AND a.archived_at IS NULL),'[]'::json) AS quote_attachments
    FROM expenses e LEFT JOIN budget_categories c ON c.id=e.budget_category_id LEFT JOIN vendors v ON v.id=e.vendor_id
    WHERE e.wedding_id=$1 AND e.archived_at IS NULL ORDER BY e.due_date NULLS LAST,e.created_at DESC`,[weddingId]);
  return { expenses:result.rows };
});
app.post('/api/weddings/:weddingId/expenses', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({name:z.string().trim().min(1).max(200),category:z.string().max(80).optional(),description:z.string().max(5000).nullable().optional(),committed:z.number().nonnegative().optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),stage:z.enum(['estimated','quoted','committed','partially_paid','paid','refunded','cancelled']).optional(),dueDate:z.string().date().nullable().optional(),budgetCategoryId:z.string().uuid().nullable().optional(),vendorId:z.string().uuid().nullable().optional()}).parse(request.body);
  const expense=await withTransaction(async client=>{await requireActiveFinanceRecord(client,weddingId,body.budgetCategoryId,'budgetCategory');await requireActiveFinanceRecord(client,weddingId,body.vendorId,'vendor');const result=await client.query(`INSERT INTO expenses (wedding_id,name,category,description,committed,currency,stage,due_date,budget_category_id,vendor_id,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,[weddingId,body.name,body.category||'Other',body.description||null,body.committed||0,body.currency||'USD',body.stage||'estimated',body.dueDate||null,body.budgetCategoryId||null,body.vendorId||null,user.id]);await audit(client,weddingId,user.id,'expense',result.rows[0].id,'created');return result.rows[0];});
  reply.code(201).send({expense});
});
app.patch('/api/weddings/:weddingId/expenses/:expenseId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,expenseId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({name:z.string().trim().min(1).max(200).optional(),category:z.string().max(80).optional(),description:z.string().max(5000).nullable().optional(),committed:z.number().nonnegative().optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),stage:z.enum(['estimated','quoted','committed','partially_paid','paid','refunded','cancelled']).optional(),dueDate:z.string().date().nullable().optional(),budgetCategoryId:z.string().uuid().nullable().optional(),vendorId:z.string().uuid().nullable().optional()}).parse(request.body);
  const fields={name:body.name,category:body.category,description:body.description,committed:body.committed,currency:body.currency,stage:body.stage,due_date:body.dueDate,budget_category_id:body.budgetCategoryId,vendor_id:body.vendorId};const entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)return reply.code(400).send({error:'No changes supplied.'});
  const expense=await withTransaction(async client=>{if(body.budgetCategoryId!==undefined)await requireActiveFinanceRecord(client,weddingId,body.budgetCategoryId,'budgetCategory');if(body.vendorId!==undefined)await requireActiveFinanceRecord(client,weddingId,body.vendorId,'vendor');const values=[weddingId,expenseId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await client.query(`UPDATE expenses SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Expense not found.',404);await audit(client,weddingId,user.id,'expense',expenseId,'updated',{fields:entries.map(([column])=>column)});return result.rows[0];});
  return {expense};
});
app.delete('/api/weddings/:weddingId/expenses/:expenseId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,expenseId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE expenses SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,expenseId,user.id]);if(!result.rows[0])throw httpError('Expense not found.',404);await audit(client,weddingId,user.id,'expense',expenseId,'archived');});
  reply.code(204).send();
});
app.post('/api/weddings/:weddingId/expenses/:expenseId/quotes', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,expenseId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const expense=await query('SELECT id FROM expenses WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL',[expenseId,weddingId]);if(!expense.rows[0])throw httpError('Expense not found.',404);
  const file=await request.file();if(!file)throw httpError('Choose one quote file to upload.');const buffer=await file.toBuffer();
  const id=crypto.randomUUID(),originalName=path.basename(file.filename||'quote'),storageKey=`${id}-${originalName.replace(/[^a-zA-Z0-9._-]/g,'_')}`;await mkdir(uploadsDirectory,{recursive:true});await writeFile(path.join(uploadsDirectory,storageKey),buffer);
  const attachment=await withTransaction(async client=>{const result=await client.query(`INSERT INTO expense_quote_attachments (id,expense_id,wedding_id,original_name,storage_key,content_type,byte_size,checksum_sha256,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,original_name,content_type,byte_size,created_at`,[id,expenseId,weddingId,originalName,storageKey,file.mimetype||'application/octet-stream',buffer.length,crypto.createHash('sha256').update(buffer).digest('hex'),user.id]);await audit(client,weddingId,user.id,'expense_quote_attachment',id,'created',{expenseId,originalName});return result.rows[0];});
  reply.code(201).send({attachment});
});
app.get('/api/weddings/:weddingId/expenses/:expenseId/quotes/:attachmentId/download', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,expenseId,attachmentId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query('SELECT original_name,storage_key,content_type FROM expense_quote_attachments WHERE id=$1 AND expense_id=$2 AND wedding_id=$3 AND archived_at IS NULL',[attachmentId,expenseId,weddingId]);if(!result.rows[0])throw httpError('Quote attachment not found.',404);const attachment=result.rows[0];reply.header('Content-Disposition',`inline; filename="${attachment.original_name.replaceAll('"','')}"`).type(attachment.content_type);return reply.send(createReadStream(path.join(uploadsDirectory,attachment.storage_key)));
});
app.delete('/api/weddings/:weddingId/expenses/:expenseId/quotes/:attachmentId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,expenseId,attachmentId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE expense_quote_attachments SET archived_at=now() WHERE id=$1 AND expense_id=$2 AND wedding_id=$3 AND archived_at IS NULL RETURNING id',[attachmentId,expenseId,weddingId]);if(!result.rows[0])throw httpError('Quote attachment not found.',404);await audit(client,weddingId,user.id,'expense_quote_attachment',attachmentId,'archived',{expenseId});});reply.code(204).send();
});
app.get('/api/weddings/:weddingId/payments', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query(`SELECT p.*,e.name AS expense_name,v.name AS vendor_name,u.display_name AS payer_name,
    COALESCE((SELECT SUM(s.amount) FROM payment_splits s WHERE s.payment_id=p.id AND s.settled_at IS NULL),0)::numeric AS reimbursement_owed,
    COALESCE((SELECT json_agg(json_build_object('id',s.id,'amount',s.amount,'settledAt',s.settled_at,'owedByUserId',s.owed_by_user_id,'owedByLabel',s.owed_by_label,'owedByName',ou.display_name) ORDER BY s.created_at) FROM payment_splits s LEFT JOIN users ou ON ou.id=s.owed_by_user_id WHERE s.payment_id=p.id),'[]'::json) AS splits,
    COALESCE((SELECT json_agg(json_build_object('id',a.id,'originalName',a.original_name,'contentType',a.content_type,'byteSize',a.byte_size,'createdAt',a.created_at) ORDER BY a.created_at) FROM payment_receipt_attachments a WHERE a.payment_id=p.id AND a.archived_at IS NULL),'[]'::json) AS receipts
    FROM payments p LEFT JOIN expenses e ON e.id=p.expense_id LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN users u ON u.id=p.payer_user_id
    WHERE p.wedding_id=$1 AND p.archived_at IS NULL ORDER BY p.paid_on DESC,p.created_at DESC`,[weddingId]);
  return {payments:result.rows};
});
app.post('/api/weddings/:weddingId/payments', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({expenseId:z.string().uuid().nullable().optional(),vendorId:z.string().uuid().nullable().optional(),payerUserId:z.string().uuid().nullable().optional(),payerLabel:z.string().max(100).nullable().optional(),amount:z.number().positive(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),paidOn:z.string().date().optional(),method:z.string().max(100).nullable().optional(),notes:z.string().max(5000).nullable().optional(),splits:z.array(z.object({owedByUserId:z.string().uuid().nullable().optional(),owedByLabel:z.string().max(100).nullable().optional(),amount:z.number().positive()})).max(20).optional()}).parse(request.body);
  if ((body.splits||[]).reduce((sum,split)=>sum+split.amount,0) > body.amount) throw httpError('Repayment splits cannot exceed the payment amount.');
  const payment=await withTransaction(async client=>{await requireActiveFinanceRecord(client,weddingId,body.expenseId,'expense');await requireActiveFinanceRecord(client,weddingId,body.vendorId,'vendor');const payer=await resolveFinanceMember(client,weddingId,body.payerUserId,body.payerLabel,'payer');const result=await client.query(`INSERT INTO payments (wedding_id,expense_id,vendor_id,payer_user_id,payer_label,amount,currency,paid_on,method,notes,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,[weddingId,body.expenseId||null,body.vendorId||null,payer.userId,payer.label,body.amount,body.currency||'USD',body.paidOn||new Date().toISOString().slice(0,10),body.method||null,body.notes||null,user.id]);for(const split of body.splits||[]){const owingMember=await resolveFinanceMember(client,weddingId,split.owedByUserId,split.owedByLabel,'person who owes');await client.query('INSERT INTO payment_splits (payment_id,owed_by_user_id,owed_by_label,amount) VALUES ($1,$2,$3,$4)',[result.rows[0].id,owingMember.userId,owingMember.label,split.amount]);}await audit(client,weddingId,user.id,'payment',result.rows[0].id,'created',{amount:body.amount,splitCount:(body.splits||[]).length});return result.rows[0];});
  reply.code(201).send({payment});
});
app.patch('/api/weddings/:weddingId/payments/:paymentId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,paymentId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({expenseId:z.string().uuid().nullable().optional(),vendorId:z.string().uuid().nullable().optional(),payerUserId:z.string().uuid().nullable().optional(),payerLabel:z.string().max(100).nullable().optional(),amount:z.number().positive().optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),paidOn:z.string().date().optional(),method:z.string().max(100).nullable().optional(),notes:z.string().max(5000).nullable().optional(),splits:z.array(z.object({owedByUserId:z.string().uuid().nullable().optional(),owedByLabel:z.string().max(100).nullable().optional(),amount:z.number().positive()})).max(20).optional()}).parse(request.body);
  const payment=await withTransaction(async client=>{
    const current=await client.query('SELECT amount FROM payments WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL FOR UPDATE',[paymentId,weddingId]);
    if(!current.rows[0])throw httpError('Payment not found.',404);
    if(body.expenseId!==undefined)await requireActiveFinanceRecord(client,weddingId,body.expenseId,'expense');
    if(body.vendorId!==undefined)await requireActiveFinanceRecord(client,weddingId,body.vendorId,'vendor');
    const effectiveAmount=body.amount===undefined?Number(current.rows[0].amount):body.amount;
    if(body.splits&&body.splits.reduce((sum,split)=>sum+split.amount,0)>effectiveAmount)throw httpError('Repayment splits cannot exceed the payment amount.');
    const fields={expense_id:body.expenseId,vendor_id:body.vendorId,amount:body.amount,currency:body.currency,paid_on:body.paidOn,method:body.method,notes:body.notes};
    if(body.payerUserId!==undefined||body.payerLabel!==undefined){const payer=await resolveFinanceMember(client,weddingId,body.payerUserId,body.payerLabel,'payer');fields.payer_user_id=payer.userId;fields.payer_label=payer.label;}
    const entries=Object.entries(fields).filter(([,value])=>value!==undefined); if(!entries.length&&body.splits===undefined)throw httpError('No changes supplied.');
    const values=[paymentId,weddingId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;}); values.push(user.id);
    const setClause=sets.length?sets.join(','):'updated_at=now()';
    const result=await client.query(`UPDATE payments SET ${setClause},updated_by=$${values.length},updated_at=now() WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL RETURNING *`,values);
    if(body.splits!==undefined){await client.query('DELETE FROM payment_splits WHERE payment_id=$1',[paymentId]);for(const split of body.splits){const owingMember=await resolveFinanceMember(client,weddingId,split.owedByUserId,split.owedByLabel,'person who owes');await client.query('INSERT INTO payment_splits (payment_id,owed_by_user_id,owed_by_label,amount) VALUES ($1,$2,$3,$4)',[paymentId,owingMember.userId,owingMember.label,split.amount]);}}
    const changedFields=[...entries.map(([column])=>column),...(body.splits!==undefined?['splits']:[])]; await audit(client,weddingId,user.id,'payment',paymentId,'updated',{fields:changedFields}); return result.rows[0];
  });
  return {payment};
});
app.delete('/api/weddings/:weddingId/payments/:paymentId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,paymentId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE payments SET archived_at=now(),updated_by=$3,updated_at=now() WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL RETURNING id',[paymentId,weddingId,user.id]);if(!result.rows[0])throw httpError('Payment not found.',404);await audit(client,weddingId,user.id,'payment',paymentId,'archived');});
  reply.code(204).send();
});
app.post('/api/weddings/:weddingId/payments/:paymentId/receipts', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,paymentId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const payment=await query('SELECT id FROM payments WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL',[paymentId,weddingId]);if(!payment.rows[0])throw httpError('Payment not found.',404);
  const file=await request.file();if(!file)throw httpError('Choose one receipt file to upload.');const buffer=await file.toBuffer();
  const id=crypto.randomUUID(),originalName=path.basename(file.filename||'receipt'),storageKey=`${id}-${originalName.replace(/[^a-zA-Z0-9._-]/g,'_')}`;await mkdir(uploadsDirectory,{recursive:true});await writeFile(path.join(uploadsDirectory,storageKey),buffer);
  const receipt=await withTransaction(async client=>{const result=await client.query(`INSERT INTO payment_receipt_attachments (id,payment_id,wedding_id,original_name,storage_key,content_type,byte_size,checksum_sha256,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,original_name,content_type,byte_size,created_at`,[id,paymentId,weddingId,originalName,storageKey,file.mimetype||'application/octet-stream',buffer.length,crypto.createHash('sha256').update(buffer).digest('hex'),user.id]);await audit(client,weddingId,user.id,'payment_receipt_attachment',id,'created',{paymentId,originalName});return result.rows[0];});
  reply.code(201).send({receipt});
});
app.get('/api/weddings/:weddingId/payments/:paymentId/receipts/:receiptId/download', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,paymentId,receiptId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query('SELECT original_name,storage_key,content_type FROM payment_receipt_attachments WHERE id=$1 AND payment_id=$2 AND wedding_id=$3 AND archived_at IS NULL',[receiptId,paymentId,weddingId]);if(!result.rows[0])throw httpError('Receipt not found.',404);const receipt=result.rows[0];reply.header('Content-Disposition',`inline; filename="${receipt.original_name.replaceAll('"','')}"`).type(receipt.content_type);return reply.send(createReadStream(path.join(uploadsDirectory,receipt.storage_key)));
});
app.delete('/api/weddings/:weddingId/payments/:paymentId/receipts/:receiptId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,paymentId,receiptId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE payment_receipt_attachments SET archived_at=now() WHERE id=$1 AND payment_id=$2 AND wedding_id=$3 AND archived_at IS NULL RETURNING id',[receiptId,paymentId,weddingId]);if(!result.rows[0])throw httpError('Receipt not found.',404);await audit(client,weddingId,user.id,'payment_receipt_attachment',receiptId,'archived',{paymentId});});reply.code(204).send();
});
app.patch('/api/weddings/:weddingId/payments/:paymentId/splits/:splitId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,paymentId,splitId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({settled:z.boolean()}).parse(request.body);
  const split=await withTransaction(async client=>{const result=await client.query(`UPDATE payment_splits s SET settled_at=CASE WHEN $4 THEN now() ELSE NULL END,settled_by=CASE WHEN $4 THEN $5 ELSE NULL END FROM payments p WHERE s.id=$1 AND s.payment_id=$2 AND p.id=s.payment_id AND p.wedding_id=$3 AND p.archived_at IS NULL RETURNING s.*`,[splitId,paymentId,weddingId,body.settled,user.id]);if(!result.rows[0])throw httpError('Reimbursement split not found.',404);await audit(client,weddingId,user.id,'payment_split',splitId,body.settled?'settled':'reopened',{paymentId});return result.rows[0];});return {split};
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
  const body=z.object({name:z.string().trim().min(1).max(200),category:z.string().max(80).optional(),status:z.enum(['researching','contacted','quoted','shortlisted','booked','declined','cancelled']).optional(),contact:z.string().max(1000).nullable().optional(),notes:z.string().max(5000).nullable().optional(),terms:z.string().max(5000).nullable().optional(),contractDueOn:z.string().date().nullable().optional(),depositDueOn:z.string().date().nullable().optional(),finalPaymentDueOn:z.string().date().nullable().optional(),serviceOn:z.string().date().nullable().optional()}).parse(request.body);
  const vendor=await withTransaction(async client=>{const result=await client.query(`INSERT INTO vendors (wedding_id,name,category,status,contact,notes,terms,contract_due_on,deposit_due_on,final_payment_due_on,service_on,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,[weddingId,body.name,body.category||'Other',body.status||'researching',body.contact||null,body.notes||null,body.terms||null,body.contractDueOn||null,body.depositDueOn||null,body.finalPaymentDueOn||null,body.serviceOn||null,user.id]);await audit(client,weddingId,user.id,'vendor',result.rows[0].id,'created');return result.rows[0];});
  reply.code(201).send({vendor});
});
app.patch('/api/weddings/:weddingId/vendors/:vendorId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,vendorId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({name:z.string().trim().min(1).max(200).optional(),category:z.string().max(80).optional(),status:z.enum(['researching','contacted','quoted','shortlisted','booked','declined','cancelled']).optional(),contact:z.string().max(1000).nullable().optional(),notes:z.string().max(5000).nullable().optional(),terms:z.string().max(5000).nullable().optional(),contractDueOn:z.string().date().nullable().optional(),depositDueOn:z.string().date().nullable().optional(),finalPaymentDueOn:z.string().date().nullable().optional(),serviceOn:z.string().date().nullable().optional()}).parse(request.body);
  const fields={name:body.name,category:body.category,status:body.status,contact:body.contact,notes:body.notes,terms:body.terms,contract_due_on:body.contractDueOn,deposit_due_on:body.depositDueOn,final_payment_due_on:body.finalPaymentDueOn,service_on:body.serviceOn},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)return reply.code(400).send({error:'No changes supplied.'});
  const vendor=await withTransaction(async client=>{const values=[weddingId,vendorId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await client.query(`UPDATE vendors SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Vendor not found.',404);await audit(client,weddingId,user.id,'vendor',vendorId,'updated',{fields:entries.map(([column])=>column)});return result.rows[0];});
  return {vendor};
});
app.delete('/api/weddings/:weddingId/vendors/:vendorId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,vendorId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE vendors SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,vendorId,user.id]);if(!result.rows[0])throw httpError('Vendor not found.',404);await audit(client,weddingId,user.id,'vendor',vendorId,'archived');});
  reply.code(204).send();
});
app.get('/api/weddings/:weddingId/vendor-quotes', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query(`SELECT q.*,v.name AS vendor_name,COALESCE((SELECT json_agg(json_build_object('id',a.id,'originalName',a.original_name,'contentType',a.content_type,'byteSize',a.byte_size,'createdAt',a.created_at) ORDER BY a.created_at) FROM vendor_quote_attachments a WHERE a.quote_id=q.id AND a.archived_at IS NULL),'[]'::json) AS attachments FROM vendor_quotes q JOIN vendors v ON v.id=q.vendor_id
    WHERE q.wedding_id=$1 AND q.archived_at IS NULL ORDER BY q.expires_on NULLS LAST,q.created_at DESC`,[weddingId]);
  return {quotes:result.rows};
});
app.post('/api/weddings/:weddingId/vendor-quotes', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({vendorId:z.string().uuid(),title:z.string().trim().min(1).max(200),amount:z.number().nonnegative().optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),expiresOn:z.string().date().nullable().optional(),notes:z.string().max(5000).nullable().optional()}).parse(request.body);
  const quote=await withTransaction(async client=>{const vendor=await client.query('SELECT id FROM vendors WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL',[body.vendorId,weddingId]);if(!vendor.rows[0])throw httpError('Vendor not found.',404);const result=await client.query(`INSERT INTO vendor_quotes (wedding_id,vendor_id,title,amount,currency,expires_on,notes,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,[weddingId,body.vendorId,body.title,body.amount||0,body.currency||'USD',body.expiresOn||null,body.notes||null,user.id]);await audit(client,weddingId,user.id,'vendor_quote',result.rows[0].id,'created',{vendorId:body.vendorId});return result.rows[0];});
  reply.code(201).send({quote});
});
app.patch('/api/weddings/:weddingId/vendor-quotes/:quoteId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,quoteId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const body=z.object({title:z.string().trim().min(1).max(200).optional(),amount:z.number().nonnegative().optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),expiresOn:z.string().date().nullable().optional(),notes:z.string().max(5000).nullable().optional()}).parse(request.body);
  const fields={title:body.title,amount:body.amount,currency:body.currency,expires_on:body.expiresOn,notes:body.notes},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');
  const quote=await withTransaction(async client=>{const values=[weddingId,quoteId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await client.query(`UPDATE vendor_quotes SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Quote not found.',404);await audit(client,weddingId,user.id,'vendor_quote',quoteId,'updated',{fields:entries.map(([column])=>column)});return result.rows[0];});
  return {quote};
});
app.delete('/api/weddings/:weddingId/vendor-quotes/:quoteId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,quoteId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE vendor_quotes SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,quoteId,user.id]);if(!result.rows[0])throw httpError('Quote not found.',404);await audit(client,weddingId,user.id,'vendor_quote',quoteId,'archived');});
  reply.code(204).send();
});
app.get('/api/weddings/:weddingId/vendor-quotes/:quoteId/attachments', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,quoteId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query('SELECT id,original_name,content_type,byte_size,created_at FROM vendor_quote_attachments WHERE wedding_id=$1 AND quote_id=$2 AND archived_at IS NULL ORDER BY created_at',[weddingId,quoteId]);return {attachments:result.rows};
});
app.post('/api/weddings/:weddingId/vendor-quotes/:quoteId/attachments', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,quoteId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const quote=await query('SELECT id FROM vendor_quotes WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL',[quoteId,weddingId]);if(!quote.rows[0])throw httpError('Quote not found.',404);
  const file=await request.file();if(!file)throw httpError('Choose one file to upload.');const buffer=await file.toBuffer();
  const id=crypto.randomUUID(),originalName=path.basename(file.filename||'attachment'),storageKey=`${id}-${originalName.replace(/[^a-zA-Z0-9._-]/g,'_')}`;await mkdir(uploadsDirectory,{recursive:true});await writeFile(path.join(uploadsDirectory,storageKey),buffer);
  const attachment=await withTransaction(async client=>{const result=await client.query(`INSERT INTO vendor_quote_attachments (id,quote_id,wedding_id,original_name,storage_key,content_type,byte_size,checksum_sha256,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,original_name,content_type,byte_size,created_at`,[id,quoteId,weddingId,originalName,storageKey,file.mimetype||'application/octet-stream',buffer.length,crypto.createHash('sha256').update(buffer).digest('hex'),user.id]);await audit(client,weddingId,user.id,'vendor_quote_attachment',id,'created',{quoteId,originalName});return result.rows[0];});reply.code(201).send({attachment});
});
app.get('/api/weddings/:weddingId/vendor-quotes/:quoteId/attachments/:attachmentId/download', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,quoteId,attachmentId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  const result=await query('SELECT original_name,storage_key,content_type FROM vendor_quote_attachments WHERE id=$1 AND quote_id=$2 AND wedding_id=$3 AND archived_at IS NULL',[attachmentId,quoteId,weddingId]);if(!result.rows[0])throw httpError('Attachment not found.',404);const attachment=result.rows[0];reply.header('Content-Disposition',`inline; filename="${attachment.original_name.replaceAll('"','')}"`).type(attachment.content_type);return reply.send(createReadStream(path.join(uploadsDirectory,attachment.storage_key)));
});
app.delete('/api/weddings/:weddingId/vendor-quotes/:quoteId/attachments/:attachmentId', async (request, reply) => {
  const user=await requireUser(request,reply); if(!user)return;
  const {weddingId,quoteId,attachmentId}=request.params; await requireMembership(user.id,weddingId,['owner','editor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE vendor_quote_attachments SET archived_at=now() WHERE id=$1 AND quote_id=$2 AND wedding_id=$3 AND archived_at IS NULL RETURNING id',[attachmentId,quoteId,weddingId]);if(!result.rows[0])throw httpError('Attachment not found.',404);await audit(client,weddingId,user.id,'vendor_quote_attachment',attachmentId,'archived',{quoteId});});reply.code(204).send();
});
app.get('/api/weddings/:weddingId/idea-boards', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,allRoles);const result=await query('SELECT * FROM idea_boards WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY created_at DESC',[weddingId]);return {boards:result.rows};
});
app.post('/api/weddings/:weddingId/idea-boards', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({name:z.string().trim().min(1).max(200),theme:z.string().trim().min(1).max(80).optional(),note:z.string().max(5000).nullable().optional(),sourceUrl:z.string().url().max(2000).nullable().optional()}).parse(request.body);const board=await withTransaction(async client=>{const result=await client.query('INSERT INTO idea_boards (wedding_id,name,theme,note,source_url,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *',[weddingId,body.name,body.theme||'palette',body.note||null,body.sourceUrl||null,user.id]);await audit(client,weddingId,user.id,'idea_board',result.rows[0].id,'created');return result.rows[0];});reply.code(201).send({board});
});
app.patch('/api/weddings/:weddingId/idea-boards/:boardId', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({name:z.string().trim().min(1).max(200).optional(),theme:z.string().trim().min(1).max(80).optional(),note:z.string().max(5000).nullable().optional(),sourceUrl:z.string().url().max(2000).nullable().optional()}).parse(request.body);const fields={name:body.name,theme:body.theme,note:body.note,source_url:body.sourceUrl},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');const board=await withTransaction(async client=>{const values=[weddingId,boardId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await client.query(`UPDATE idea_boards SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Idea board not found.',404);await audit(client,weddingId,user.id,'idea_board',boardId,'updated',{fields:entries.map(([column])=>column)});return result.rows[0];});return {board};
});
app.delete('/api/weddings/:weddingId/idea-boards/:boardId', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const result=await client.query('UPDATE idea_boards SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,boardId,user.id]);if(!result.rows[0])throw httpError('Idea board not found.',404);await audit(client,weddingId,user.id,'idea_board',boardId,'archived');});reply.code(204).send();
});
app.get('/api/weddings/:weddingId/idea-boards/:boardId/attachments', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId}=request.params;await requireMembership(user.id,weddingId,allRoles);const result=await query(`SELECT a.id,a.caption,a.source_url,a.original_name,a.content_type,a.byte_size,a.created_at,a.updated_at,COALESCE((SELECT json_agg(json_build_object('id',c.id,'body',c.body,'createdBy',c.created_by,'authorName',u.display_name,'createdAt',c.created_at) ORDER BY c.created_at) FROM idea_attachment_comments c JOIN users u ON u.id=c.created_by WHERE c.attachment_id=a.id AND c.archived_at IS NULL),'[]'::json) AS comments FROM idea_board_attachments a WHERE a.wedding_id=$1 AND a.board_id=$2 AND a.archived_at IS NULL ORDER BY a.created_at`,[weddingId,boardId]);return {attachments:result.rows};
});
app.post('/api/weddings/:weddingId/idea-boards/:boardId/attachments', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({caption:z.string().trim().min(1).max(500),sourceUrl:z.string().url().max(2000).nullable().optional()}).parse(request.body);const attachment=await withTransaction(async client=>{const board=await client.query('SELECT id FROM idea_boards WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL',[boardId,weddingId]);if(!board.rows[0])throw httpError('Idea board not found.',404);const result=await client.query('INSERT INTO idea_board_attachments (board_id,wedding_id,caption,source_url,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id,caption,source_url,original_name,content_type,byte_size,created_at,updated_at',[boardId,weddingId,body.caption,body.sourceUrl||null,user.id]);await audit(client,weddingId,user.id,'idea_attachment',result.rows[0].id,'created',{boardId});return result.rows[0];});reply.code(201).send({attachment});
});
app.patch('/api/weddings/:weddingId/idea-boards/:boardId/attachments/:attachmentId', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId,attachmentId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({caption:z.string().trim().min(1).max(500).optional(),sourceUrl:z.string().url().max(2000).nullable().optional()}).parse(request.body);const fields={caption:body.caption,source_url:body.sourceUrl},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');const attachment=await withTransaction(async client=>{const values=[weddingId,boardId,attachmentId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+4}`;});values.push(user.id);const result=await client.query(`UPDATE idea_board_attachments SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND board_id=$2 AND id=$3 AND archived_at IS NULL RETURNING id,caption,source_url,original_name,content_type,byte_size,created_at,updated_at`,values);if(!result.rows[0])throw httpError('Attachment not found.',404);await audit(client,weddingId,user.id,'idea_attachment',attachmentId,'updated',{boardId});return result.rows[0];});return {attachment};
});
app.post('/api/weddings/:weddingId/idea-boards/:boardId/attachments/:attachmentId/file', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId,attachmentId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const exists=await query('SELECT id FROM idea_board_attachments WHERE id=$1 AND board_id=$2 AND wedding_id=$3 AND archived_at IS NULL',[attachmentId,boardId,weddingId]);if(!exists.rows[0])throw httpError('Attachment not found.',404);const file=await request.file();if(!file)throw httpError('Choose one file to upload.');const buffer=await file.toBuffer(),originalName=path.basename(file.filename||'attachment'),storageKey=`${attachmentId}-${originalName.replace(/[^a-zA-Z0-9._-]/g,'_')}`;await mkdir(uploadsDirectory,{recursive:true});await writeFile(path.join(uploadsDirectory,storageKey),buffer);const attachment=await withTransaction(async client=>{const result=await client.query('UPDATE idea_board_attachments SET original_name=$4,storage_key=$5,content_type=$6,byte_size=$7,checksum_sha256=$8,updated_by=$9,updated_at=now() WHERE id=$1 AND board_id=$2 AND wedding_id=$3 RETURNING id,caption,source_url,original_name,content_type,byte_size,created_at,updated_at',[attachmentId,boardId,weddingId,originalName,storageKey,file.mimetype||'application/octet-stream',buffer.length,crypto.createHash('sha256').update(buffer).digest('hex'),user.id]);await audit(client,weddingId,user.id,'idea_attachment',attachmentId,'file_uploaded',{boardId,originalName});return result.rows[0];});return {attachment};
});
app.get('/api/weddings/:weddingId/idea-boards/:boardId/attachments/:attachmentId/download', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId,attachmentId}=request.params;await requireMembership(user.id,weddingId,allRoles);const result=await query('SELECT original_name,storage_key,content_type FROM idea_board_attachments WHERE id=$1 AND board_id=$2 AND wedding_id=$3 AND archived_at IS NULL',[attachmentId,boardId,weddingId]);if(!result.rows[0]||!result.rows[0].storage_key)throw httpError('File not found.',404);const attachment=result.rows[0];reply.header('Content-Disposition',`inline; filename="${attachment.original_name.replaceAll('"','')}"`).type(attachment.content_type);return reply.send(createReadStream(path.join(uploadsDirectory,attachment.storage_key)));
});
app.delete('/api/weddings/:weddingId/idea-boards/:boardId/attachments/:attachmentId', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId,attachmentId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const result=await client.query('UPDATE idea_board_attachments SET archived_at=now(),updated_by=$4,updated_at=now() WHERE id=$1 AND board_id=$2 AND wedding_id=$3 AND archived_at IS NULL RETURNING id',[attachmentId,boardId,weddingId,user.id]);if(!result.rows[0])throw httpError('Attachment not found.',404);await audit(client,weddingId,user.id,'idea_attachment',attachmentId,'archived',{boardId});});reply.code(204).send();
});
app.post('/api/weddings/:weddingId/idea-boards/:boardId/attachments/:attachmentId/comments', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId,attachmentId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({body:z.string().trim().min(1).max(5000)}).parse(request.body);const comment=await withTransaction(async client=>{const attachment=await client.query('SELECT id FROM idea_board_attachments WHERE id=$1 AND board_id=$2 AND wedding_id=$3 AND archived_at IS NULL',[attachmentId,boardId,weddingId]);if(!attachment.rows[0])throw httpError('Attachment not found.',404);const result=await client.query('INSERT INTO idea_attachment_comments (attachment_id,wedding_id,body,created_by,updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING id,body,created_by,created_at',[attachmentId,weddingId,body.body,user.id]);await audit(client,weddingId,user.id,'idea_attachment_comment',result.rows[0].id,'created',{boardId,attachmentId});return {...result.rows[0],author_name:user.display_name};});reply.code(201).send({comment});
});
app.patch('/api/weddings/:weddingId/idea-boards/:boardId/attachments/:attachmentId/comments/:commentId', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId,attachmentId,commentId}=request.params;const membership=await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({body:z.string().trim().min(1).max(5000)}).parse(request.body);const comment=await withTransaction(async client=>{const current=await client.query('SELECT created_by FROM idea_attachment_comments WHERE id=$1 AND attachment_id=$2 AND wedding_id=$3 AND archived_at IS NULL FOR UPDATE',[commentId,attachmentId,weddingId]);if(!current.rows[0])throw httpError('Comment not found.',404);if(membership.role!=='owner'&&current.rows[0].created_by!==user.id)throw httpError('Only the author or an owner can edit this comment.',403);const result=await client.query('UPDATE idea_attachment_comments SET body=$4,updated_by=$5,updated_at=now() WHERE id=$1 AND attachment_id=$2 AND wedding_id=$3 RETURNING id,body,created_by,created_at',[commentId,attachmentId,weddingId,body.body,user.id]);await audit(client,weddingId,user.id,'idea_attachment_comment',commentId,'updated',{boardId,attachmentId});return result.rows[0];});return {comment};
});
app.delete('/api/weddings/:weddingId/idea-boards/:boardId/attachments/:attachmentId/comments/:commentId', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,boardId,attachmentId,commentId}=request.params;const membership=await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const current=await client.query('SELECT created_by FROM idea_attachment_comments WHERE id=$1 AND attachment_id=$2 AND wedding_id=$3 AND archived_at IS NULL FOR UPDATE',[commentId,attachmentId,weddingId]);if(!current.rows[0])throw httpError('Comment not found.',404);if(membership.role!=='owner'&&current.rows[0].created_by!==user.id)throw httpError('Only the author or an owner can delete this comment.',403);await client.query('UPDATE idea_attachment_comments SET archived_at=now(),updated_by=$4,updated_at=now() WHERE id=$1 AND attachment_id=$2 AND wedding_id=$3',[commentId,attachmentId,weddingId,user.id]);await audit(client,weddingId,user.id,'idea_attachment_comment',commentId,'archived',{boardId,attachmentId});});reply.code(204).send();
});
function validateTravelRange(record){if(record.endsOn&&record.startsOn&&record.endsOn<record.startsOn)throw httpError('The end date cannot be before the start date.');if(record.endsOn===record.startsOn&&record.startsAt&&record.endsAt&&record.endsAt<record.startsAt)throw httpError('The end time cannot be before the start time.');}
app.get('/api/weddings/:weddingId/honeymoon', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,allRoles);const [profile,reservations]=await Promise.all([query('SELECT * FROM honeymoon_profiles WHERE wedding_id=$1',[weddingId]),query('SELECT * FROM travel_reservations WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY starts_on NULLS LAST,due_date NULLS LAST,created_at DESC',[weddingId])]);return {profile:profile.rows[0]||{destination:'',dates_label:'',description:'',starts_on:null,ends_on:null,planned_budget:0,other_committed:0},reservations:reservations.rows};
});
app.put('/api/weddings/:weddingId/honeymoon', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor']);const body=z.object({destination:z.string().max(200).nullable().optional(),datesLabel:z.string().max(200).nullable().optional(),description:z.string().max(2000).nullable().optional(),startsOn:z.string().date().nullable().optional(),endsOn:z.string().date().nullable().optional(),plannedBudget:z.number().nonnegative().optional(),otherCommitted:z.number().nonnegative().optional()}).parse(request.body);validateTravelRange(body);const profile=await withTransaction(async client=>{const result=await client.query(`INSERT INTO honeymoon_profiles (wedding_id,destination,dates_label,description,starts_on,ends_on,planned_budget,other_committed,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (wedding_id) DO UPDATE SET destination=EXCLUDED.destination,dates_label=EXCLUDED.dates_label,description=EXCLUDED.description,starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,planned_budget=EXCLUDED.planned_budget,other_committed=EXCLUDED.other_committed,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[weddingId,body.destination||null,body.datesLabel||null,body.description||null,body.startsOn||null,body.endsOn||null,body.plannedBudget||0,body.otherCommitted||0,user.id]);await audit(client,weddingId,user.id,'honeymoon_profile',weddingId,'updated');return result.rows[0];});return {profile};
});
app.post('/api/weddings/:weddingId/honeymoon/reservations', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({name:z.string().trim().min(1).max(200),type:z.enum(['flight','stay','activity','transport','other']).optional(),status:z.enum(['pending','confirmed','cancelled']).optional(),confirmation:z.string().max(200).nullable().optional(),details:z.string().max(2000).nullable().optional(),startsOn:z.string().date().nullable().optional(),endsOn:z.string().date().nullable().optional(),startsAt:z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),endsAt:z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),total:z.number().nonnegative().optional(),paid:z.number().nonnegative().optional(),dueDate:z.string().date().nullable().optional()}).parse(request.body);validateTravelRange(body);const reservation=await withTransaction(async client=>{const result=await client.query('INSERT INTO travel_reservations (wedding_id,name,type,status,confirmation,details,starts_on,ends_on,starts_at,ends_at,total,paid,due_date,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *',[weddingId,body.name,body.type||'other',body.status||'pending',body.confirmation||null,body.details||null,body.startsOn||null,body.endsOn||null,body.startsAt||null,body.endsAt||null,body.total||0,body.paid||0,body.dueDate||null,user.id]);await audit(client,weddingId,user.id,'travel_reservation',result.rows[0].id,'created');return result.rows[0];});reply.code(201).send({reservation});
});
app.patch('/api/weddings/:weddingId/honeymoon/reservations/:reservationId', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,reservationId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({name:z.string().trim().min(1).max(200).optional(),type:z.enum(['flight','stay','activity','transport','other']).optional(),status:z.enum(['pending','confirmed','cancelled']).optional(),confirmation:z.string().max(200).nullable().optional(),details:z.string().max(2000).nullable().optional(),startsOn:z.string().date().nullable().optional(),endsOn:z.string().date().nullable().optional(),startsAt:z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),endsAt:z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),total:z.number().nonnegative().optional(),paid:z.number().nonnegative().optional(),dueDate:z.string().date().nullable().optional()}).parse(request.body);const fields={name:body.name,type:body.type,status:body.status,confirmation:body.confirmation,details:body.details,starts_on:body.startsOn,ends_on:body.endsOn,starts_at:body.startsAt,ends_at:body.endsAt,total:body.total,paid:body.paid,due_date:body.dueDate},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');const reservation=await withTransaction(async client=>{const current=(await client.query('SELECT starts_on,ends_on,starts_at,ends_at FROM travel_reservations WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE',[weddingId,reservationId])).rows[0];if(!current)throw httpError('Reservation not found.',404);validateTravelRange({startsOn:body.startsOn??current.starts_on,endsOn:body.endsOn===undefined?current.ends_on:body.endsOn,startsAt:body.startsAt===undefined?current.starts_at:body.startsAt,endsAt:body.endsAt===undefined?current.ends_at:body.endsAt});const values=[weddingId,reservationId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await client.query(`UPDATE travel_reservations SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);await audit(client,weddingId,user.id,'travel_reservation',reservationId,'updated');return result.rows[0];});return {reservation};
});
app.delete('/api/weddings/:weddingId/honeymoon/reservations/:reservationId', async (request, reply) => {
  const user=await requireUser(request,reply);if(!user)return;const {weddingId,reservationId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const result=await client.query('UPDATE travel_reservations SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,reservationId,user.id]);if(!result.rows[0])throw httpError('Reservation not found.',404);await audit(client,weddingId,user.id,'travel_reservation',reservationId,'archived');});reply.code(204).send();
});
app.get('/api/weddings/:weddingId/honeymoon/itinerary', async (request, reply) => {const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,allRoles);const result=await query('SELECT * FROM honeymoon_itinerary_items WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY planned_on,created_at',[weddingId]);return {items:result.rows};});
app.post('/api/weddings/:weddingId/honeymoon/itinerary', async (request, reply) => {const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({title:z.string().trim().min(1).max(250),plannedOn:z.string().date(),note:z.string().max(2000).nullable().optional()}).parse(request.body);const item=await withTransaction(async client=>{const result=await client.query('INSERT INTO honeymoon_itinerary_items (wedding_id,title,planned_on,note,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *',[weddingId,body.title,body.plannedOn,body.note||null,user.id]);await audit(client,weddingId,user.id,'honeymoon_itinerary',result.rows[0].id,'created');return result.rows[0];});reply.code(201).send({item});});
app.patch('/api/weddings/:weddingId/honeymoon/itinerary/:itemId', async (request, reply) => {const user=await requireUser(request,reply);if(!user)return;const {weddingId,itemId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({title:z.string().trim().min(1).max(250).optional(),plannedOn:z.string().date().optional(),note:z.string().max(2000).nullable().optional()}).parse(request.body);const fields={title:body.title,planned_on:body.plannedOn,note:body.note},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');const item=await withTransaction(async client=>{const values=[weddingId,itemId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await client.query(`UPDATE honeymoon_itinerary_items SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Itinerary item not found.',404);await audit(client,weddingId,user.id,'honeymoon_itinerary',itemId,'updated');return result.rows[0];});return {item};});
app.delete('/api/weddings/:weddingId/honeymoon/itinerary/:itemId', async (request, reply) => {const user=await requireUser(request,reply);if(!user)return;const {weddingId,itemId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const result=await client.query('UPDATE honeymoon_itinerary_items SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,itemId,user.id]);if(!result.rows[0])throw httpError('Itinerary item not found.',404);await audit(client,weddingId,user.id,'honeymoon_itinerary',itemId,'archived');});reply.code(204).send();});
app.get('/api/weddings/:weddingId/honeymoon/packing', async (request, reply) => {const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,allRoles);const result=await query('SELECT * FROM honeymoon_packing_items WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY packed,created_at',[weddingId]);return {items:result.rows};});
app.post('/api/weddings/:weddingId/honeymoon/packing', async (request, reply) => {const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({title:z.string().trim().min(1).max(250),dueOn:z.string().date().nullable().optional()}).parse(request.body);const item=await withTransaction(async client=>{const result=await client.query('INSERT INTO honeymoon_packing_items (wedding_id,title,due_on,created_by,updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING *',[weddingId,body.title,body.dueOn||null,user.id]);await audit(client,weddingId,user.id,'honeymoon_packing',result.rows[0].id,'created');return result.rows[0];});reply.code(201).send({item});});
app.patch('/api/weddings/:weddingId/honeymoon/packing/:itemId', async (request, reply) => {const user=await requireUser(request,reply);if(!user)return;const {weddingId,itemId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({title:z.string().trim().min(1).max(250).optional(),packed:z.boolean().optional(),dueOn:z.string().date().nullable().optional()}).parse(request.body);const fields={title:body.title,packed:body.packed,due_on:body.dueOn},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');const values=[weddingId,itemId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await query(`UPDATE honeymoon_packing_items SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Packing item not found.',404);await query(`INSERT INTO audit_events (wedding_id,actor_id,entity_type,entity_id,action) VALUES ($1,$2,'honeymoon_packing',$3,'updated')`,[weddingId,user.id,itemId]);return {item:result.rows[0]};});
app.delete('/api/weddings/:weddingId/honeymoon/packing/:itemId', async (request, reply) => {const user=await requireUser(request,reply);if(!user)return;const {weddingId,itemId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const result=await client.query('UPDATE honeymoon_packing_items SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,itemId,user.id]);if(!result.rows[0])throw httpError('Packing item not found.',404);await audit(client,weddingId,user.id,'honeymoon_packing',itemId,'archived');});reply.code(204).send();});
app.get('/api/weddings/:weddingId/honeymoon/documents',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,allRoles);const result=await query('SELECT id,title,note,status,expires_on,original_name,content_type,byte_size,created_at,updated_at FROM honeymoon_documents WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY status,created_at',[weddingId]);return {documents:result.rows};});
app.post('/api/weddings/:weddingId/honeymoon/documents',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({title:z.string().trim().min(1).max(250),note:z.string().max(2000).nullable().optional(),status:z.enum(['to_do','ready']).optional(),expiresOn:z.string().date().nullable().optional()}).parse(request.body);const document=await withTransaction(async client=>{const result=await client.query('INSERT INTO honeymoon_documents (wedding_id,title,note,status,expires_on,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id,title,note,status,expires_on,original_name,content_type,byte_size,created_at,updated_at',[weddingId,body.title,body.note||null,body.status||'to_do',body.expiresOn||null,user.id]);await audit(client,weddingId,user.id,'honeymoon_document',result.rows[0].id,'created');return result.rows[0];});reply.code(201).send({document});});
app.patch('/api/weddings/:weddingId/honeymoon/documents/:documentId',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,documentId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({title:z.string().trim().min(1).max(250).optional(),note:z.string().max(2000).nullable().optional(),status:z.enum(['to_do','ready']).optional(),expiresOn:z.string().date().nullable().optional()}).parse(request.body);const fields={title:body.title,note:body.note,status:body.status,expires_on:body.expiresOn},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');const values=[weddingId,documentId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await query(`UPDATE honeymoon_documents SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id,title,note,status,expires_on,original_name,content_type,byte_size,created_at,updated_at`,values);if(!result.rows[0])throw httpError('Travel document not found.',404);return {document:result.rows[0]};});
app.post('/api/weddings/:weddingId/honeymoon/documents/:documentId/file',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,documentId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const exists=await query('SELECT id FROM honeymoon_documents WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL',[documentId,weddingId]);if(!exists.rows[0])throw httpError('Travel document not found.',404);const file=await request.file();if(!file)throw httpError('Choose one file to upload.');const buffer=await file.toBuffer(),originalName=path.basename(file.filename||'document'),storageKey=`${documentId}-${originalName.replace(/[^a-zA-Z0-9._-]/g,'_')}`;await mkdir(uploadsDirectory,{recursive:true});await writeFile(path.join(uploadsDirectory,storageKey),buffer);const result=await query('UPDATE honeymoon_documents SET original_name=$3,storage_key=$4,content_type=$5,byte_size=$6,checksum_sha256=$7,updated_by=$8,updated_at=now() WHERE id=$1 AND wedding_id=$2 RETURNING id,title,note,status,original_name,content_type,byte_size,created_at,updated_at',[documentId,weddingId,originalName,storageKey,file.mimetype||'application/octet-stream',buffer.length,crypto.createHash('sha256').update(buffer).digest('hex'),user.id]);return {document:result.rows[0]};});
app.get('/api/weddings/:weddingId/honeymoon/documents/:documentId/download',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,documentId}=request.params;await requireMembership(user.id,weddingId,allRoles);const result=await query('SELECT original_name,storage_key,content_type FROM honeymoon_documents WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL',[documentId,weddingId]);if(!result.rows[0]||!result.rows[0].storage_key)throw httpError('File not found.',404);const document=result.rows[0];reply.header('Content-Disposition',`inline; filename="${document.original_name.replaceAll('"','')}"`).type(document.content_type);return reply.send(createReadStream(path.join(uploadsDirectory,document.storage_key)));});
app.delete('/api/weddings/:weddingId/honeymoon/documents/:documentId',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,documentId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const result=await client.query('UPDATE honeymoon_documents SET archived_at=now(),updated_by=$3,updated_at=now() WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL RETURNING id',[documentId,weddingId,user.id]);if(!result.rows[0])throw httpError('Travel document not found.',404);await audit(client,weddingId,user.id,'honeymoon_document',documentId,'archived');});reply.code(204).send();});
app.get('/api/weddings/:weddingId/guests',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,allRoles);const result=await query('SELECT * FROM guests WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY name',[weddingId]);return {guests:result.rows};});
app.post('/api/weddings/:weddingId/guests',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({name:z.string().trim().min(1).max(250),group:z.string().max(120).nullable().optional(),partySize:z.number().int().positive().optional(),rsvp:z.enum(['pending','attending','declined']).optional(),notes:z.string().max(5000).nullable().optional()}).parse(request.body);const guest=await withTransaction(async client=>{const result=await client.query('INSERT INTO guests (wedding_id,name,guest_group,party_size,rsvp,notes,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *',[weddingId,body.name,body.group||null,body.partySize||1,body.rsvp||'pending',body.notes||null,user.id]);await audit(client,weddingId,user.id,'guest',result.rows[0].id,'created');return result.rows[0];});reply.code(201).send({guest});});
app.patch('/api/weddings/:weddingId/guests/:guestId',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,guestId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({name:z.string().trim().min(1).max(250).optional(),group:z.string().max(120).nullable().optional(),partySize:z.number().int().positive().optional(),rsvp:z.enum(['pending','attending','declined']).optional(),notes:z.string().max(5000).nullable().optional()}).parse(request.body);const fields={name:body.name,guest_group:body.group,party_size:body.partySize,rsvp:body.rsvp,notes:body.notes},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');const values=[weddingId,guestId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await query(`UPDATE guests SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Guest not found.',404);return {guest:result.rows[0]};});
app.delete('/api/weddings/:weddingId/guests/:guestId',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,guestId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const result=await client.query('UPDATE guests SET archived_at=now(),updated_by=$3,updated_at=now() WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL RETURNING id',[guestId,weddingId,user.id]);if(!result.rows[0])throw httpError('Guest not found.',404);await audit(client,weddingId,user.id,'guest',guestId,'archived');});reply.code(204).send();});
app.get('/api/weddings/:weddingId/contacts',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,allRoles);const result=await query('SELECT * FROM day_of_contacts WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY name',[weddingId]);return {contacts:result.rows};});
app.post('/api/weddings/:weddingId/contacts',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({name:z.string().trim().min(1).max(250),role:z.string().max(250).nullable().optional(),contact:z.string().max(500).nullable().optional()}).parse(request.body);const contact=await withTransaction(async client=>{const result=await client.query('INSERT INTO day_of_contacts (wedding_id,name,role,contact,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *',[weddingId,body.name,body.role||null,body.contact||null,user.id]);await audit(client,weddingId,user.id,'day_of_contact',result.rows[0].id,'created');return result.rows[0];});reply.code(201).send({contact});});
app.patch('/api/weddings/:weddingId/contacts/:contactId',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,contactId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({name:z.string().trim().min(1).max(250).optional(),role:z.string().max(250).nullable().optional(),contact:z.string().max(500).nullable().optional()}).parse(request.body);const fields={name:body.name,role:body.role,contact:body.contact},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');const values=[weddingId,contactId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await query(`UPDATE day_of_contacts SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Contact not found.',404);return {contact:result.rows[0]};});
app.delete('/api/weddings/:weddingId/contacts/:contactId',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,contactId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const result=await client.query('UPDATE day_of_contacts SET archived_at=now(),updated_by=$3,updated_at=now() WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL RETURNING id',[contactId,weddingId,user.id]);if(!result.rows[0])throw httpError('Contact not found.',404);await audit(client,weddingId,user.id,'day_of_contact',contactId,'archived');});reply.code(204).send();});
app.get('/api/weddings/:weddingId/rings-attire',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,allRoles);const [rings,appointments]=await Promise.all([query('SELECT * FROM ring_checklist_items WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY completed,created_at',[weddingId]),query('SELECT * FROM attire_appointments WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY appointment_on,created_at',[weddingId])]);return {rings:rings.rows,appointments:appointments.rows};});
app.post('/api/weddings/:weddingId/rings',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({title:z.string().trim().min(1).max(250),note:z.string().max(2000).nullable().optional(),completed:z.boolean().optional()}).parse(request.body);const item=await withTransaction(async client=>{const result=await client.query('INSERT INTO ring_checklist_items (wedding_id,title,note,completed,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *',[weddingId,body.title,body.note||null,body.completed||false,user.id]);await audit(client,weddingId,user.id,'ring_checklist_item',result.rows[0].id,'created');return result.rows[0];});reply.code(201).send({item});});
app.patch('/api/weddings/:weddingId/rings/:itemId',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,itemId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({title:z.string().trim().min(1).max(250).optional(),note:z.string().max(2000).nullable().optional(),completed:z.boolean().optional()}).parse(request.body);const fields={title:body.title,note:body.note,completed:body.completed},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');const values=[weddingId,itemId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await query(`UPDATE ring_checklist_items SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Ring item not found.',404);await audit(pool,weddingId,user.id,'ring_checklist_item',itemId,'updated');return {item:result.rows[0]};});
app.delete('/api/weddings/:weddingId/rings/:itemId',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,itemId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const result=await client.query('UPDATE ring_checklist_items SET archived_at=now(),updated_by=$3,updated_at=now() WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL RETURNING id',[itemId,weddingId,user.id]);if(!result.rows[0])throw httpError('Ring item not found.',404);await audit(client,weddingId,user.id,'ring_checklist_item',itemId,'archived');});reply.code(204).send();});
app.post('/api/weddings/:weddingId/attire-appointments',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({title:z.string().trim().min(1).max(250),location:z.string().max(1000).nullable().optional(),appointmentOn:z.string().date()}).parse(request.body);const appointment=await withTransaction(async client=>{const result=await client.query('INSERT INTO attire_appointments (wedding_id,title,location,appointment_on,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *',[weddingId,body.title,body.location||null,body.appointmentOn,user.id]);await audit(client,weddingId,user.id,'attire_appointment',result.rows[0].id,'created');return result.rows[0];});reply.code(201).send({appointment});});
app.patch('/api/weddings/:weddingId/attire-appointments/:appointmentId',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,appointmentId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);const body=z.object({title:z.string().trim().min(1).max(250).optional(),location:z.string().max(1000).nullable().optional(),appointmentOn:z.string().date().optional()}).parse(request.body);const fields={title:body.title,location:body.location,appointment_on:body.appointmentOn},entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');const values=[weddingId,appointmentId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const result=await query(`UPDATE attire_appointments SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL RETURNING *`,values);if(!result.rows[0])throw httpError('Attire appointment not found.',404);await audit(pool,weddingId,user.id,'attire_appointment',appointmentId,'updated');return {appointment:result.rows[0]};});
app.delete('/api/weddings/:weddingId/attire-appointments/:appointmentId',async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;const {weddingId,appointmentId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);await withTransaction(async client=>{const result=await client.query('UPDATE attire_appointments SET archived_at=now(),updated_by=$3,updated_at=now() WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL RETURNING id',[appointmentId,weddingId,user.id]);if(!result.rows[0])throw httpError('Attire appointment not found.',404);await audit(client,weddingId,user.id,'attire_appointment',appointmentId,'archived');});reply.code(204).send();});
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
  const body = z.object({ title:z.string().min(1).max(250), category:z.string().max(80).optional(), priority:z.enum(['Low','Medium','High']).optional(), assignee:z.string().max(100).nullable().optional(), assigneeUserId:z.string().uuid().nullable().optional(), notes:z.string().max(5000).nullable().optional(), linkedVendor:z.string().trim().max(2000).nullable().optional(), dueDate:z.string().date().nullable().optional(), status:z.enum(['todo','progress','done']).optional(), position:z.number().int().nonnegative().optional() }).parse(request.body);
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
    assigneeUserId:z.string().uuid().nullable().optional(), notes:z.string().max(5000).nullable().optional(), linkedVendor:z.string().trim().max(2000).nullable().optional(),
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
app.post('/api/weddings/:weddingId/imports/legacy-backup', async (request, reply) => {
  const user=await ownerUser(request,reply);if(!user)return;const {weddingId}=request.params;const body=z.object({backup:z.any()}).parse(request.body),fingerprint=crypto.createHash('sha256').update(JSON.stringify(body.backup)).digest('hex'),data=body.backup?.data||body.backup||{},items=key=>Array.isArray(data[key])?data[key]:[],clean=value=>String(value||'').trim();
  const previous=await query(`SELECT id FROM audit_events WHERE wedding_id=$1 AND entity_type='legacy_backup' AND action='imported' AND details->>'fingerprint'=$2 LIMIT 1`,[weddingId,fingerprint]);if(previous.rows[0])throw httpError('This exact backup was already imported into this workspace. Create a new export or review the existing shared records instead.',409);
  const valid={tasks:items('everAfterTasks').filter(item=>Array.isArray(item)&&clean(item[0])).slice(0,500),vendors:items('everAfterVendors').filter(item=>clean(item?.name)).slice(0,500),expenses:items('everAfterExpenses').filter(item=>clean(item?.name)).slice(0,500),guests:items('everAfterGuests').filter(item=>clean(item?.name)).slice(0,1000),contacts:items('everAfterContacts').filter(item=>clean(item?.name)).slice(0,500),rings:items('everAfterRingItems').filter(item=>clean(item?.title)).slice(0,500),attire:items('everAfterAttireAppointments').filter(item=>clean(item?.title)&&/^\d{4}-\d{2}-\d{2}$/.test(item?.date||'')).slice(0,500),reservations:items('everAfterReservations').filter(item=>clean(item?.name)).slice(0,500),itinerary:items('everAfterItineraryItems').filter(item=>clean(item?.title)&&/^\d{4}-\d{2}-\d{2}$/.test(item?.date||'')).slice(0,500),packing:items('everAfterPackingItems').filter(item=>clean(item?.title)).slice(0,500)};
  const imported=await withTransaction(async client=>{const counts={};const nextPosition=async status=>Number((await client.query('SELECT COALESCE(MAX(position),-1)+1 AS position FROM tasks WHERE wedding_id=$1 AND status=$2 AND archived_at IS NULL',[weddingId,status])).rows[0].position);const positions={todo:await nextPosition('todo'),progress:await nextPosition('progress'),done:await nextPosition('done')};counts.tasks=0;for(const item of valid.tasks){const status=['todo','progress','done'].includes(item[4])?item[4]:item[3]?'done':'todo';await client.query('INSERT INTO tasks (wedding_id,title,category,priority,assignee,notes,due_date,status,position,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)',[weddingId,clean(item[0]).slice(0,250),clean(item[1]).slice(0,80)||'Other',['Low','Medium','High'].includes(item[6])?item[6]:'Medium',clean(item[7]).slice(0,160)||'Unassigned',clean(item[8]).slice(0,5000)||null,/^\d{4}-\d{2}-\d{2}$/.test(item[10]||'')?item[10]:null,status,positions[status]++,user.id]);counts.tasks++;}
    counts.vendors=0;for(const item of valid.vendors){const status=['researching','contacted','quoted','shortlisted','booked','declined','cancelled'].includes(String(item.status||'').toLowerCase())?String(item.status).toLowerCase():'researching';await client.query('INSERT INTO vendors (wedding_id,name,category,status,contact,notes,terms,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',[weddingId,clean(item.name).slice(0,250),clean(item.category).slice(0,120)||'Other',status,clean(item.contact).slice(0,1000)||null,clean(item.notes).slice(0,5000)||null,clean(item.terms).slice(0,5000)||null,user.id]);counts.vendors++;}
    counts.expenses=0;for(const item of valid.expenses){const stage={Planned:'estimated',Quoted:'quoted',Committed:'committed',Paid:'paid'}[item.status]||'estimated';await client.query('INSERT INTO expenses (wedding_id,name,category,committed,currency,stage,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',[weddingId,clean(item.name).slice(0,250),clean(item.category).slice(0,120)||'Other',Math.max(0,Number(item.committed)||0),'USD',stage,user.id]);counts.expenses++;}
    counts.guests=0;for(const item of valid.guests){const rsvp={Attending:'attending',Declined:'declined',Pending:'pending'}[item.rsvp]||'pending';await client.query('INSERT INTO guests (wedding_id,name,guest_group,party_size,rsvp,notes,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',[weddingId,clean(item.name).slice(0,250),clean(item.group).slice(0,120)||null,Math.max(1,Math.floor(Number(item.party)||1)),rsvp,clean(item.notes).slice(0,5000)||null,user.id]);counts.guests++;}
    counts.contacts=0;for(const item of valid.contacts){await client.query('INSERT INTO day_of_contacts (wedding_id,name,role,contact,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5)',[weddingId,clean(item.name).slice(0,250),clean(item.role).slice(0,250)||null,clean(item.contact).slice(0,500)||null,user.id]);counts.contacts++;}
    counts.rings=0;for(const item of valid.rings){await client.query('INSERT INTO ring_checklist_items (wedding_id,title,note,completed,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5)',[weddingId,clean(item.title).slice(0,250),clean(item.note).slice(0,2000)||null,Boolean(item.complete),user.id]);counts.rings++;}
    counts.attire=0;for(const item of valid.attire){await client.query('INSERT INTO attire_appointments (wedding_id,title,location,appointment_on,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5)',[weddingId,clean(item.title).slice(0,250),clean(item.location).slice(0,1000)||null,item.date,user.id]);counts.attire++;}
    counts.reservations=0;for(const item of valid.reservations){await client.query('INSERT INTO travel_reservations (wedding_id,name,type,status,confirmation,details,total,paid,due_date,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)',[weddingId,clean(item.name).slice(0,200),['flight','stay','activity','transport','other'].includes(item.type)?item.type:'other',['pending','confirmed','cancelled'].includes(String(item.status||'').toLowerCase())?String(item.status).toLowerCase():'pending',clean(item.confirmation).slice(0,200)||null,clean(item.details).slice(0,2000)||null,Math.max(0,Number(item.total)||0),Math.max(0,Number(item.paid)||0),/^\d{4}-\d{2}-\d{2}$/.test(item.due||'')?item.due:null,user.id]);counts.reservations++;}
    counts.itinerary=0;for(const item of valid.itinerary){await client.query('INSERT INTO honeymoon_itinerary_items (wedding_id,title,planned_on,note,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$5)',[weddingId,clean(item.title).slice(0,250),item.date,clean(item.note).slice(0,2000)||null,user.id]);counts.itinerary++;}counts.packing=0;for(const item of valid.packing){await client.query('INSERT INTO honeymoon_packing_items (wedding_id,title,packed,created_by,updated_by) VALUES ($1,$2,$3,$4,$4)',[weddingId,clean(item.title).slice(0,250),Boolean(item.complete),user.id]);counts.packing++;}await audit(client,weddingId,user.id,'legacy_backup',null,'imported',{...counts,fingerprint});return counts;});reply.code(201).send({imported,skippedAttachments:items('everAfterIdeaBoards').reduce((count,board)=>count+(board?.attachments?.length||0),0)+items('everAfterPayments').filter(item=>item?.receiptData).length+items('everAfterTravelDocuments').filter(item=>item?.file||item?.data).length});
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
  const body = z.object({ title:z.string().min(1).max(250).optional(), category:z.string().max(80).optional(), priority:z.enum(['Low','Medium','High']).optional(), assignee:z.string().max(100).nullable().optional(), assigneeUserId:z.string().uuid().nullable().optional(), notes:z.string().max(5000).nullable().optional(), linkedVendor:z.string().trim().max(2000).nullable().optional(), dueDate:z.string().date().nullable().optional(), status:z.enum(['todo','progress','done']).optional(), position:z.number().int().nonnegative().optional() }).parse(request.body);
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

const scheduleEventTypes=['meeting','appointment','reminder','travel','ceremony','other'];
function validateScheduleEvent(event) {
  if (event.endsOn && event.endsOn < event.startsOn) throw httpError('The end date cannot be before the start date.');
  if (event.endsOn === event.startsOn && event.startsAt && event.endsAt && event.endsAt < event.startsAt) throw httpError('The end time cannot be before the start time.');
}
const scheduleEventBody=z.object({
  title:z.string().trim().min(1).max(250).optional(), eventType:z.enum(scheduleEventTypes).optional(),
  startsOn:z.string().date().optional(), endsOn:z.string().date().nullable().optional(),
  startsAt:z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(), endsAt:z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  location:z.string().trim().max(1000).nullable().optional(), notes:z.string().trim().max(5000).nullable().optional()
});
app.get('/api/weddings/:weddingId/events',async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const {weddingId}=request.params;await requireMembership(user.id,weddingId,allRoles);
  const range=z.object({from:z.string().date(),to:z.string().date()}).parse(request.query);
  if(range.to<range.from)throw httpError('The schedule range is invalid.');
  const result=await query(`SELECT e.*,u.display_name AS created_by_name FROM schedule_events e
    LEFT JOIN users u ON u.id=e.created_by
    WHERE e.wedding_id=$1 AND e.archived_at IS NULL AND e.starts_on <= $3 AND COALESCE(e.ends_on,e.starts_on) >= $2
    ORDER BY e.starts_on,e.starts_at NULLS LAST,e.created_at`,[weddingId,range.from,range.to]);
  return {events:result.rows};
});
app.post('/api/weddings/:weddingId/events',async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const {weddingId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);
  const body=scheduleEventBody.extend({title:z.string().trim().min(1).max(250),startsOn:z.string().date()}).parse(request.body);
  validateScheduleEvent(body);
  const event=await withTransaction(async client=>{const result=await client.query(`INSERT INTO schedule_events
    (wedding_id,title,event_type,starts_on,ends_on,starts_at,ends_at,location,notes,created_by,updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,[weddingId,body.title,body.eventType||'other',body.startsOn,body.endsOn||null,body.startsAt||null,body.endsAt||null,body.location||null,body.notes||null,user.id]);
    await audit(client,weddingId,user.id,'schedule_event',result.rows[0].id,'created');return result.rows[0];});
  reply.code(201).send({event});
});
app.patch('/api/weddings/:weddingId/events/:eventId',async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const {weddingId,eventId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);
  const body=scheduleEventBody.parse(request.body);
  const event=await withTransaction(async client=>{const current=(await client.query('SELECT * FROM schedule_events WHERE id=$1 AND wedding_id=$2 AND archived_at IS NULL FOR UPDATE',[eventId,weddingId])).rows[0];
    if(!current)throw httpError('Schedule event not found.',404);
    const merged={title:body.title??current.title,eventType:body.eventType??current.event_type,startsOn:body.startsOn??current.starts_on,endsOn:body.endsOn===undefined?current.ends_on:body.endsOn,startsAt:body.startsAt===undefined?current.starts_at:body.startsAt,endsAt:body.endsAt===undefined?current.ends_at:body.endsAt};
    validateScheduleEvent(merged);
    const fields={title:body.title,event_type:body.eventType,starts_on:body.startsOn,ends_on:body.endsOn,starts_at:body.startsAt,ends_at:body.endsAt,location:body.location,notes:body.notes};
    const entries=Object.entries(fields).filter(([,value])=>value!==undefined);if(!entries.length)throw httpError('No changes supplied.');
    const values=[weddingId,eventId],sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);
    const result=await client.query(`UPDATE schedule_events SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 RETURNING *`,values);
    await audit(client,weddingId,user.id,'schedule_event',eventId,'updated',{fields:entries.map(([column])=>column)});return result.rows[0];});
  return {event};
});
app.delete('/api/weddings/:weddingId/events/:eventId',async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const {weddingId,eventId}=request.params;await requireMembership(user.id,weddingId,['owner','editor','contributor']);
  await withTransaction(async client=>{const result=await client.query('UPDATE schedule_events SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,eventId,user.id]);if(!result.rows[0])throw httpError('Schedule event not found.',404);await audit(client,weddingId,user.id,'schedule_event',eventId,'archived');});
  reply.code(204).send();
});
app.get('/api/weddings/:weddingId/schedule',async(request,reply)=>{
  const user=await requireUser(request,reply);if(!user)return;
  const {weddingId}=request.params;await requireMembership(user.id,weddingId,allRoles);
  const range=z.object({from:z.string().date(),to:z.string().date()}).parse(request.query);
  if(range.to<range.from)throw httpError('The schedule range is invalid.');
  const [manual,wedding,honeymoonProfile,tasks,expenses,payments,vendorMilestones,quotes,reservations,itinerary,appointments,packing,documents]=await Promise.all([
    query(`SELECT id,title,event_type,starts_on,ends_on,starts_at,ends_at,location,notes FROM schedule_events WHERE wedding_id=$1 AND archived_at IS NULL AND starts_on <= $3 AND COALESCE(ends_on,starts_on) >= $2 ORDER BY starts_on,starts_at NULLS LAST,created_at`,[weddingId,range.from,range.to]),
    query('SELECT id,name,wedding_date,rsvp_deadline,location FROM weddings WHERE id=$1 AND (wedding_date BETWEEN $2 AND $3 OR rsvp_deadline BETWEEN $2 AND $3)',[weddingId,range.from,range.to]),
    query('SELECT wedding_id,destination,starts_on,ends_on FROM honeymoon_profiles WHERE wedding_id=$1 AND starts_on <= $3 AND COALESCE(ends_on,starts_on) >= $2',[weddingId,range.from,range.to]),
    query('SELECT id,title,category,priority,status,due_date FROM tasks WHERE wedding_id=$1 AND archived_at IS NULL AND due_date BETWEEN $2 AND $3',[weddingId,range.from,range.to]),
    query('SELECT id,name,category,committed,stage,due_date FROM expenses WHERE wedding_id=$1 AND archived_at IS NULL AND due_date BETWEEN $2 AND $3',[weddingId,range.from,range.to]),
    query(`SELECT p.id,p.amount,p.paid_on,COALESCE(e.name,v.name,'Unlinked payment') AS title FROM payments p LEFT JOIN expenses e ON e.id=p.expense_id LEFT JOIN vendors v ON v.id=p.vendor_id WHERE p.wedding_id=$1 AND p.archived_at IS NULL AND p.paid_on BETWEEN $2 AND $3`,[weddingId,range.from,range.to]),
    query(`SELECT id,name,contract_due_on,deposit_due_on,final_payment_due_on,service_on FROM vendors WHERE wedding_id=$1 AND archived_at IS NULL AND (contract_due_on BETWEEN $2 AND $3 OR deposit_due_on BETWEEN $2 AND $3 OR final_payment_due_on BETWEEN $2 AND $3 OR service_on BETWEEN $2 AND $3)`,[weddingId,range.from,range.to]),
    query(`SELECT q.id,q.title,q.expires_on,v.name AS vendor_name FROM vendor_quotes q JOIN vendors v ON v.id=q.vendor_id WHERE q.wedding_id=$1 AND q.archived_at IS NULL AND q.expires_on BETWEEN $2 AND $3`,[weddingId,range.from,range.to]),
    query('SELECT id,name,type,status,due_date,starts_on,ends_on,starts_at,ends_at,total,paid FROM travel_reservations WHERE wedding_id=$1 AND archived_at IS NULL AND (due_date BETWEEN $2 AND $3 OR (starts_on <= $3 AND COALESCE(ends_on,starts_on) >= $2))',[weddingId,range.from,range.to]),
    query('SELECT id,title,planned_on,note FROM honeymoon_itinerary_items WHERE wedding_id=$1 AND archived_at IS NULL AND planned_on BETWEEN $2 AND $3',[weddingId,range.from,range.to]),
    query('SELECT id,title,location,appointment_on FROM attire_appointments WHERE wedding_id=$1 AND archived_at IS NULL AND appointment_on BETWEEN $2 AND $3',[weddingId,range.from,range.to]),
    query('SELECT id,title,due_on,packed FROM honeymoon_packing_items WHERE wedding_id=$1 AND archived_at IS NULL AND due_on BETWEEN $2 AND $3',[weddingId,range.from,range.to]),
    query('SELECT id,title,expires_on,status FROM honeymoon_documents WHERE wedding_id=$1 AND archived_at IS NULL AND expires_on BETWEEN $2 AND $3',[weddingId,range.from,range.to])
  ]);
  const items=[
    ...manual.rows.map(row=>({id:`manual:${row.id}`,kind:'manual',category:'manual',sourceId:row.id,title:row.title,startsOn:row.starts_on,endsOn:row.ends_on,startsAt:row.starts_at,endsAt:row.ends_at,location:row.location,notes:row.notes,eventType:row.event_type,linked:false})),
    ...wedding.rows.flatMap(row=>[...(row.wedding_date?[{id:`wedding:${row.id}`,kind:'wedding',category:'ceremony',sourceId:row.id,title:row.name,startsOn:row.wedding_date,location:row.location,linked:true}]:[]),...(row.rsvp_deadline?[{id:`rsvp:${row.id}`,kind:'rsvp',category:'manual',sourceId:row.id,title:'RSVP deadline',startsOn:row.rsvp_deadline,notes:row.name,linked:true}]:[])]),
    ...honeymoonProfile.rows.map(row=>({id:`honeymoon:${row.wedding_id}`,kind:'honeymoon',category:'travel',sourceId:row.wedding_id,title:row.destination||'Honeymoon trip',startsOn:row.starts_on,endsOn:row.ends_on,linked:true})),
    ...tasks.rows.map(row=>({id:`task:${row.id}`,kind:'task',category:'task',sourceId:row.id,title:row.title,startsOn:row.due_date,status:row.status,priority:row.priority,notes:row.category,linked:true})),
    ...expenses.rows.map(row=>({id:`expense:${row.id}`,kind:'expense',category:'money',sourceId:row.id,title:row.name,startsOn:row.due_date,status:row.stage,amount:Number(row.committed),notes:row.category,linked:true})),
    ...payments.rows.map(row=>({id:`payment:${row.id}`,kind:'payment',category:'money',sourceId:row.id,title:row.title,startsOn:row.paid_on,status:'paid',amount:Number(row.amount),linked:true})),
    ...vendorMilestones.rows.flatMap(row=>[['contract_due_on','Contract due','vendor'],['deposit_due_on','Deposit due','money'],['final_payment_due_on','Final payment due','money'],['service_on','Service day','vendor']].filter(([column])=>row[column]).map(([column,label,category])=>({id:`vendor:${column}:${row.id}`,kind:'vendor',category,sourceId:row.id,title:row.name,startsOn:row[column],notes:label,linked:true}))),
    ...quotes.rows.map(row=>({id:`vendor_quote:${row.id}`,kind:'vendor_quote',category:'vendor',sourceId:row.id,title:row.title,startsOn:row.expires_on,notes:row.vendor_name,linked:true})),
    ...reservations.rows.flatMap(row=>[...(row.starts_on?[{id:`reservation-trip:${row.id}`,kind:'reservation',category:'travel',sourceId:row.id,title:row.name,startsOn:row.starts_on,endsOn:row.ends_on,startsAt:row.starts_at,endsAt:row.ends_at,status:row.status,notes:row.type,linked:true}]:[]),...(row.due_date?[{id:`reservation-due:${row.id}`,kind:'reservation',category:'money',sourceId:row.id,title:row.name,startsOn:row.due_date,status:row.status,amount:Number(row.total)-Number(row.paid),notes:`${row.type} payment due`,linked:true}]:[])]),
    ...itinerary.rows.map(row=>({id:`itinerary:${row.id}`,kind:'itinerary',category:'travel',sourceId:row.id,title:row.title,startsOn:row.planned_on,notes:row.note,linked:true})),
    ...appointments.rows.map(row=>({id:`attire:${row.id}`,kind:'attire',category:'appointment',sourceId:row.id,title:row.title,startsOn:row.appointment_on,location:row.location,linked:true})),
    ...packing.rows.map(row=>({id:`packing:${row.id}`,kind:'packing',category:'task',sourceId:row.id,title:row.title,startsOn:row.due_on,status:row.packed?'packed':'needed',notes:'Packing reminder',linked:true})),
    ...documents.rows.map(row=>({id:`document:${row.id}`,kind:'document',category:'task',sourceId:row.id,title:row.title,startsOn:row.expires_on,status:row.status,notes:'Document expiry',linked:true}))
  ].sort((a,b)=>String(a.startsOn).localeCompare(String(b.startsOn))||String(a.startsAt||'').localeCompare(String(b.startsAt||''))||a.title.localeCompare(b.title));
  return {items};
});

app.setErrorHandler((error, request, reply) => {
  if (error.name === 'ZodError') {
    const field = error.issues?.[0]?.path?.[0];
    const message = field === 'linkedVendor'
      ? 'Linked vendor or reference must be 2,000 characters or fewer.'
      : 'Invalid request.';
    return reply.code(400).send({ error: message, details: error.issues });
  }
  if (error.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'That file is too large. Attachments can be up to 50 MB.' });
  request.log.error(error);
  reply.code(error.statusCode || 500).send({ error: error.statusCode ? error.message : 'Request failed.' });
});
app.addHook('onClose', async () => pool.end());
await app.listen({ port: Number(process.env.PORT || 3000), host: process.env.HOST || '0.0.0.0' });
