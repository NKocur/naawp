import crypto from 'node:crypto';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { pool, query, withTransaction } from './db.js';

const scrypt = promisify(crypto.scrypt);
const app = Fastify({ logger: true, trustProxy: true });
const isProduction = process.env.NODE_ENV === 'production';
const sessionName = 'ever_after_session';
const allRoles = ['owner', 'editor', 'contributor', 'viewer'];
const invitationRoles = ['owner', 'editor', 'contributor', 'viewer'];

await app.register(cookie);
await app.register(rateLimit, { global: true, max: 200, timeWindow: '1 minute' });

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
  const result = await query('SELECT * FROM tasks WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY status,position,created_at', [weddingId]);
  return { tasks: result.rows };
});
app.post('/api/weddings/:weddingId/tasks', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { weddingId } = request.params;
  await requireMembership(user.id, weddingId, ['owner', 'editor', 'contributor']);
  const body = z.object({ title:z.string().min(1).max(250), category:z.string().max(80).optional(), priority:z.enum(['Low','Medium','High']).optional(), assignee:z.string().max(100).optional(), notes:z.string().max(5000).optional(), linkedVendor:z.string().max(160).optional(), dueDate:z.string().date().optional(), status:z.enum(['todo','progress','done']).optional(), position:z.number().int().nonnegative().optional() }).parse(request.body);
  const task = await withTransaction(async client => {
    const result = await client.query(`INSERT INTO tasks (wedding_id,title,category,priority,assignee,notes,linked_vendor,due_date,status,position,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`, [weddingId,body.title,body.category||'Other',body.priority||'Medium',body.assignee||null,body.notes||null,body.linkedVendor||null,body.dueDate||null,body.status||'todo',body.position||0,user.id]);
    await audit(client,weddingId,user.id,'task',result.rows[0].id,'created');
    return result.rows[0];
  });
  reply.code(201).send({ task });
});
app.patch('/api/weddings/:weddingId/tasks/:taskId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { weddingId, taskId } = request.params;
  await requireMembership(user.id, weddingId, ['owner','editor','contributor']);
  const body = z.object({ title:z.string().min(1).max(250).optional(), category:z.string().max(80).optional(), priority:z.enum(['Low','Medium','High']).optional(), assignee:z.string().max(100).nullable().optional(), notes:z.string().max(5000).nullable().optional(), linkedVendor:z.string().max(160).nullable().optional(), dueDate:z.string().date().nullable().optional(), status:z.enum(['todo','progress','done']).optional(), position:z.number().int().nonnegative().optional() }).parse(request.body);
  const fields={title:body.title,category:body.category,priority:body.priority,assignee:body.assignee,notes:body.notes,linked_vendor:body.linkedVendor,due_date:body.dueDate,status:body.status,position:body.position};
  const entries=Object.entries(fields).filter(([,value])=>value!==undefined);
  if(!entries.length)return reply.code(400).send({error:'No changes supplied.'});
  const task=await withTransaction(async client=>{
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
