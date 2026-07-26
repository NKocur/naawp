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

await app.register(cookie);
await app.register(rateLimit, { global: true, max: 200, timeWindow: '1 minute' });

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
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
  await query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval \'14 days\')', [userId, hashToken(token)]);
  return token;
}
async function currentUser(request) {
  const token = request.cookies[sessionName];
  if (!token) return null;
  const result = await query(`SELECT u.id, u.email, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [hashToken(token)]);
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
  if (!membership || !allowedRoles.includes(membership.role)) {
    const error = new Error('You do not have permission for this workspace.'); error.statusCode = 403; throw error;
  }
  return membership;
}
async function audit(client, weddingId, actorId, entityType, entityId, action, details = {}) {
  await client.query('INSERT INTO audit_events (wedding_id, actor_id, entity_type, entity_id, action, details) VALUES ($1,$2,$3,$4,$5,$6)', [weddingId, actorId, entityType, entityId, action, details]);
}

app.get('/api/health', async () => ({ ok: true }));

app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(12).max(128), displayName: z.string().min(1).max(100), weddingName: z.string().min(1).max(160), weddingDate: z.string().date().optional(), location: z.string().max(160).optional() }).parse(request.body);
  const email = body.email.trim().toLowerCase();
  const result = await withTransaction(async client => {
    const passwordHash = await hashPassword(body.password);
    const user = await client.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id,email,display_name', [email, passwordHash, body.displayName.trim()]);
    const wedding = await client.query('INSERT INTO weddings (name, wedding_date, location, created_by) VALUES ($1,$2,$3,$4) RETURNING id,name,wedding_date,location', [body.weddingName.trim(), body.weddingDate || null, body.location?.trim() || null, user.rows[0].id]);
    await client.query('INSERT INTO memberships (wedding_id,user_id,role) VALUES ($1,$2,\'owner\')', [wedding.rows[0].id, user.rows[0].id]);
    await audit(client, wedding.rows[0].id, user.rows[0].id, 'wedding', wedding.rows[0].id, 'created');
    return { user: user.rows[0], wedding: wedding.rows[0] };
  });
  const token = await createSession(result.user.id); setSession(reply, token); reply.code(201).send(result);
});

app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(1).max(128) }).parse(request.body);
  const result = await query('SELECT id,email,display_name,password_hash FROM users WHERE email=$1', [body.email.trim().toLowerCase()]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(body.password, user.password_hash))) return reply.code(401).send({ error: 'Invalid email or password.' });
  const token = await createSession(user.id); setSession(reply, token); reply.send({ user: { id: user.id, email: user.email, display_name: user.display_name } });
});

app.post('/api/auth/logout', async (request, reply) => { const token = request.cookies[sessionName]; if (token) await query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]); clearSession(reply); reply.code(204).send(); });
app.get('/api/auth/me', async (request) => ({ user: await currentUser(request) }));

app.get('/api/weddings', async (request, reply) => { const user = await requireUser(request, reply); if (!user) return; const result = await query(`SELECT w.id,w.name,w.wedding_date,w.location,m.role FROM weddings w JOIN memberships m ON m.wedding_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at`, [user.id]); return { weddings: result.rows }; });

app.get('/api/weddings/:weddingId/tasks', async (request, reply) => { const user = await requireUser(request, reply); if (!user) return; const { weddingId } = request.params; await requireMembership(user.id, weddingId, ['owner','editor','contributor','viewer']); const result = await query('SELECT * FROM tasks WHERE wedding_id=$1 AND archived_at IS NULL ORDER BY status,position,created_at', [weddingId]); return { tasks: result.rows }; });
app.post('/api/weddings/:weddingId/tasks', async (request, reply) => { const user = await requireUser(request, reply); if (!user) return; const { weddingId } = request.params; await requireMembership(user.id, weddingId, ['owner','editor','contributor']); const body = z.object({ title:z.string().min(1).max(250), category:z.string().max(80).optional(), priority:z.enum(['Low','Medium','High']).optional(), assignee:z.string().max(100).optional(), notes:z.string().max(5000).optional(), linkedVendor:z.string().max(160).optional(), dueDate:z.string().date().optional(), status:z.enum(['todo','progress','done']).optional(), position:z.number().int().nonnegative().optional() }).parse(request.body); const result = await withTransaction(async client => { const task = await client.query('INSERT INTO tasks (wedding_id,title,category,priority,assignee,notes,linked_vendor,due_date,status,position,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *', [weddingId,body.title,body.category||'Other',body.priority||'Medium',body.assignee||null,body.notes||null,body.linkedVendor||null,body.dueDate||null,body.status||'todo',body.position||0,user.id]); await audit(client,weddingId,user.id,'task',task.rows[0].id,'created'); return task.rows[0]; }); reply.code(201).send({ task: result }); });
app.patch('/api/weddings/:weddingId/tasks/:taskId', async (request, reply) => { const user = await requireUser(request, reply); if (!user) return; const { weddingId, taskId } = request.params; await requireMembership(user.id, weddingId, ['owner','editor','contributor']); const body = z.object({ title:z.string().min(1).max(250).optional(), category:z.string().max(80).optional(), priority:z.enum(['Low','Medium','High']).optional(), assignee:z.string().max(100).nullable().optional(), notes:z.string().max(5000).nullable().optional(), linkedVendor:z.string().max(160).nullable().optional(), dueDate:z.string().date().nullable().optional(), status:z.enum(['todo','progress','done']).optional(), position:z.number().int().nonnegative().optional() }).parse(request.body); const fields={title:body.title,category:body.category,priority:body.priority,assignee:body.assignee,notes:body.notes,linked_vendor:body.linkedVendor,due_date:body.dueDate,status:body.status,position:body.position}; const entries=Object.entries(fields).filter(([,value])=>value!==undefined); if(!entries.length)return reply.code(400).send({error:'No changes supplied.'}); const result=await withTransaction(async client=>{const values=[weddingId,taskId];const sets=entries.map(([column,value],index)=>{values.push(value);return `${column}=$${index+3}`;});values.push(user.id);const task=await client.query(`UPDATE tasks SET ${sets.join(',')},updated_by=$${values.length},updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING *`,values);if(!task.rows[0]){const error=new Error('Task not found.');error.statusCode=404;throw error;}await audit(client,weddingId,user.id,'task',taskId,'updated',{fields:entries.map(([column])=>column)});return task.rows[0];});return {task:result}; });
app.delete('/api/weddings/:weddingId/tasks/:taskId', async (request, reply) => { const user=await requireUser(request,reply); if(!user)return; const {weddingId,taskId}=request.params; await requireMembership(user.id,weddingId,['owner','editor','contributor']); await withTransaction(async client=>{const result=await client.query('UPDATE tasks SET archived_at=now(),updated_by=$3,updated_at=now() WHERE wedding_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id',[weddingId,taskId,user.id]);if(!result.rows[0]){const error=new Error('Task not found.');error.statusCode=404;throw error;}await audit(client,weddingId,user.id,'task',taskId,'archived');}); reply.code(204).send(); });

app.setErrorHandler((error, request, reply) => { if (error.name === 'ZodError') return reply.code(400).send({ error: 'Invalid request.', details: error.issues }); request.log.error(error); reply.code(error.statusCode || 500).send({ error: 'Request failed.' }); });
app.addHook('onClose', async () => pool.end());
await app.listen({ port: Number(process.env.PORT || 3000), host: process.env.HOST || '0.0.0.0' });
