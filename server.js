import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import webpush from 'web-push';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const uploadDir = process.env.UPLOAD_DIR || path.join(root, 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
const dbPath = process.env.DB_FILE || path.join(dataDir, 'whispr.json');
const secretPath = path.join(dataDir, '.jwt-secret');
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set in production.');
const secret = process.env.JWT_SECRET || (fs.existsSync(secretPath) ? fs.readFileSync(secretPath, 'utf8') : crypto.randomBytes(32).toString('hex'));
if (!process.env.JWT_SECRET && !fs.existsSync(secretPath)) fs.writeFileSync(secretPath, secret, { mode: 0o600 });
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: uploadDir, limits: { fileSize: 25 * 1024 * 1024 } });
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined }) : null;

const blank = () => ({ users: [], chats: [], messages: [], files: [], reports: [], settings: { registrationOpen: true } });
let db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : blank();
db.pushSubscriptions ||= [];
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidConfigured = !!(vapidPublicKey && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (vapidConfigured) webpush.setVapidDetails(process.env.VAPID_SUBJECT, vapidPublicKey, process.env.VAPID_PRIVATE_KEY);
const pendingCalls = new Map();
let saveQueue = Promise.resolve();
const save = () => {
  const state = JSON.stringify(db);
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  if (!pool) return Promise.resolve();
  saveQueue = saveQueue.then(() => pool.query('UPDATE whispr_state SET state = $1::jsonb, updated_at = NOW() WHERE id = 1', [state]));
  return saveQueue;
};
const id = () => crypto.randomUUID();
const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar ? `/avatars/${u.id}` : null, bio: u.bio || '', role: u.role, createdAt: u.createdAt, online: onlineUsers.has(u.id), lastSeen: u.lastSeen || null });
const onlineUsers = new Map();
const groupCalls = new Map();
const activeGroupCallsByChat = new Map();
const tokenFor = (u) => jwt.sign({ id: u.id }, secret, { expiresIn: '7d' });
const mediaUrl = (file, userId) => `/media/${file.id}?token=${encodeURIComponent(jwt.sign({ scope: 'media', fileId: file.id, userId }, secret, { expiresIn: '30m' }))}`;
async function pushToUser(userId, payload, ttl = 60) {
  if (!vapidConfigured) return;
  let removed = false;
  await Promise.all(db.pushSubscriptions.filter((item) => item.userId === userId).map(async (item) => {
    try { await webpush.sendNotification(item.subscription, JSON.stringify(payload), { TTL: ttl, urgency: 'high' }); }
    catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) { db.pushSubscriptions = db.pushSubscriptions.filter((saved) => saved.subscription.endpoint !== item.subscription.endpoint); removed = true; }
      else console.warn('Call push notification failed:', error.message);
    }
  }));
  if (removed) await save();
}
const getUser = (req) => db.users.find((u) => u.id === req.user.id);
const members = (chat) => chat.memberIds.map((memberId) => db.users.find((u) => u.id === memberId)).filter(Boolean);
const peer = (chat, userId) => members(chat).find((u) => u.id !== userId);
function chatView(chat, userId) {
  const last = db.messages.filter((m) => m.chatId === chat.id && !(m.deletedFor || []).includes(userId)).at(-1);
  const other = peer(chat, userId);
  return { ...chat, participants: members(chat).map(publicUser), title: chat.isGroup ? chat.name : other?.name || 'Unknown user', avatar: chat.isGroup ? null : other?.avatar || null, online: !chat.isGroup && !!other && onlineUsers.has(other.id), lastMessage: last || null };
}
function authorize(req, res, next) {
  const raw = req.headers.authorization?.replace('Bearer ', '');
  try { req.user = jwt.verify(raw, secret); next(); } catch { res.status(401).json({ error: 'Please sign in again.' }); }
}
function admin(req, res, next) { const u = getUser(req); if (u?.role === 'admin') next(); else res.status(403).json({ error: 'Admin access required.' }); }
function emitPresence(userId) { io.emit('presence', { userId, online: onlineUsers.has(userId) }); }
function socketChat(socket, chatId) { return db.chats.find((c) => c.id === chatId && c.memberIds.includes(socket.user.id)); }
function groupCallRoom(callId) { return `group-call:${callId}`; }
function groupCallView(call) { return { callId: call.id, chatId: call.chatId, video: call.video, groupName: call.name, participants: [...call.participants.keys()].map((userId) => publicUser(db.users.find((user) => user.id === userId))).filter(Boolean) }; }
function removeGroupCallParticipant(call, userId) {
  if (!call.participants.has(userId)) return;
  call.participants.delete(userId);
  io.to(groupCallRoom(call.id)).emit('group-call:participant-left', { callId: call.id, userId });
  if (!call.participants.size) { groupCalls.delete(call.id); activeGroupCallsByChat.delete(call.chatId); }
}

app.use(express.json());
app.get('/avatars/:userId', (req, res) => { const user = db.users.find((u) => u.id === req.params.userId && u.avatar); if (!user) return res.sendStatus(404); res.sendFile(path.join(uploadDir, path.basename(user.avatar)), { headers: { 'Content-Type': user.avatarMime || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60' } }); });
app.get('/media/:fileId', (req, res) => { try { const claims = jwt.verify(req.query.token, secret); const file = db.files.find((item) => item.id === req.params.fileId && item.id === claims.fileId); const chat = db.chats.find((item) => item.id === file?.chatId && item.memberIds.includes(claims.userId)); if (claims.scope !== 'media' || !file || !chat) return res.sendStatus(404); const storedName = file.storageName || path.basename(file.url || ''); if (!storedName) return res.sendStatus(404); res.sendFile(path.join(uploadDir, storedName), { headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60' } }); } catch { res.sendStatus(401); } });
app.use((req, res, next) => { if (/^\/(data|uploads|node_modules|\.git)(\/|$)/.test(req.path) || ['/server.js', '/smoke.js', '/package.json', '/package-lock.json', '/render.yaml', '/README.md'].includes(req.path)) return res.sendStatus(404); next(); });
app.use(express.static(root));
app.get('/', (req, res) => res.sendFile(path.join(root, 'login.html')));

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!db.settings.registrationOpen) return res.status(403).json({ error: 'Registration is currently closed.' });
  if (!name?.trim() || !email?.trim() || !password || password.length < 8) return res.status(400).json({ error: 'Name, email, and an 8-character password are required.' });
  if (db.users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) return res.status(409).json({ error: 'An account already uses that email.' });
  const user = { id: id(), name: name.trim(), email: email.trim().toLowerCase(), password: await bcrypt.hash(password, 12), bio: '', role: db.users.length === 0 ? 'admin' : 'member', createdAt: new Date().toISOString(), lastSeen: null };
  db.users.push(user); await save(); res.status(201).json({ token: tokenFor(user), user: publicUser(user) });
});
app.post('/api/auth/login', async (req, res) => {
  const user = db.users.find((u) => u.email === String(req.body.email || '').trim().toLowerCase());
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) return res.status(401).json({ error: 'Incorrect email or password.' });
  res.json({ token: tokenFor(user), user: publicUser(user) });
});
app.get('/api/me', authorize, (req, res) => res.json(publicUser(getUser(req))));
app.get('/api/rtc-config', authorize, (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL && process.env.TURN_SHARED_SECRET) {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const username = `${expiresAt}:${req.user.id}`;
    const credential = createHmac('sha1', process.env.TURN_SHARED_SECRET).update(username).digest('base64');
    iceServers.push({ urls: process.env.TURN_URL.split(',').map((value) => value.trim()), username, credential });
  }
  res.set('Cache-Control', 'no-store').json({ iceServers });
});
app.get('/api/push/public-key', authorize, (req, res) => res.set('Cache-Control', 'no-store').json({ enabled: vapidConfigured, publicKey: vapidConfigured ? vapidPublicKey : null }));
app.post('/api/push/subscriptions', authorize, async (req, res) => {
  if (!vapidConfigured) return res.status(503).json({ error: 'Background notifications are not configured on this server yet.' });
  const subscription = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ error: 'A valid push subscription is required.' });
  let endpoint;
  try { endpoint = new URL(subscription.endpoint); } catch { return res.status(400).json({ error: 'Invalid push endpoint.' }); }
  const trustedPushHosts = ['fcm.googleapis.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];
  if (endpoint.protocol !== 'https:' || !trustedPushHosts.some((host) => endpoint.hostname === host || endpoint.hostname.endsWith(`.${host}`))) return res.status(400).json({ error: 'Unsupported push service endpoint.' });
  db.pushSubscriptions = db.pushSubscriptions.filter((item) => item.userId !== req.user.id || item.subscription.endpoint !== subscription.endpoint);
  db.pushSubscriptions.push({ userId: req.user.id, subscription }); await save(); res.status(201).json({ ok: true });
});
app.delete('/api/push/subscriptions', authorize, async (req, res) => { const endpoint = String(req.body?.endpoint || ''); db.pushSubscriptions = db.pushSubscriptions.filter((item) => item.userId !== req.user.id || item.subscription.endpoint !== endpoint); await save(); res.status(204).end(); });
app.get('/api/calls/pending/:callId', authorize, (req, res) => {
  const pending = pendingCalls.get(req.params.callId);
  if (pending && pending.toUserId === req.user.id && pending.expiresAt >= Date.now()) return res.set('Cache-Control', 'no-store').json(pending.payload);
  const groupCall = groupCalls.get(req.params.callId); const chat = groupCall && db.chats.find((item) => item.id === groupCall.chatId && item.memberIds.includes(req.user.id));
  if (groupCall && chat) return res.set('Cache-Control', 'no-store').json({ type: 'group', ...groupCallView(groupCall), from: publicUser(db.users.find((user) => user.id === groupCall.hostId)) });
  res.sendStatus(404);
});
app.patch('/api/me', authorize, async (req, res) => { const u = getUser(req); const name = String(req.body.name || '').trim(); if (!name) return res.status(400).json({ error: 'Name is required.' }); u.name = name; u.bio = String(req.body.bio || '').trim().slice(0, 160); await save(); res.json(publicUser(u)); });
app.post('/api/me/avatar', authorize, upload.single('avatar'), async (req, res) => { if (!req.file || !['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(req.file.mimetype)) return res.status(400).json({ error: 'Choose a JPEG, PNG, GIF, WebP, or AVIF image.' }); const u = getUser(req); u.avatar = `/uploads/${req.file.filename}`; u.avatarMime = req.file.mimetype; await save(); res.json(publicUser(u)); });

app.get('/api/users', authorize, (req, res) => { const q = String(req.query.q || '').toLowerCase(); res.json(db.users.filter((u) => u.id !== req.user.id && (!q || u.name.toLowerCase().includes(q) || u.email.includes(q))).map(publicUser)); });
app.get('/api/chats', authorize, (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const list = db.chats.filter((c) => c.memberIds.includes(req.user.id)).map((c) => chatView(c, req.user.id)).filter((c) => !q || c.title.toLowerCase().includes(q)).sort((a,b) => new Date(b.lastMessage?.createdAt || b.createdAt) - new Date(a.lastMessage?.createdAt || a.createdAt));
  res.json(list);
});
app.post('/api/chats', authorize, async (req, res) => {
  const ids = [...new Set([req.user.id, ...(req.body.memberIds || [])])];
  if (ids.length < 2 || ids.some((x) => !db.users.some((u) => u.id === x))) return res.status(400).json({ error: 'Select at least one valid person.' });
  const isGroup = !!req.body.isGroup || ids.length > 2 || !!String(req.body.name || '').trim();
  let chat = !isGroup && db.chats.find((c) => !c.isGroup && c.memberIds.length === 2 && ids.every((x) => c.memberIds.includes(x)));
  if (!chat) { chat = { id: id(), memberIds: ids, isGroup, name: isGroup ? String(req.body.name || '').trim() || 'Untitled group' : null, createdAt: new Date().toISOString() }; db.chats.push(chat); await save(); }
  for (const memberId of ids) io.in(`user:${memberId}`).socketsJoin(`chat:${chat.id}`);
  res.status(201).json(chatView(chat, req.user.id));
});
app.get('/api/chats/:chatId/messages', authorize, (req, res) => { const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c) return res.status(404).json({ error: 'Chat not found.' }); res.json(db.messages.filter((m) => m.chatId === c.id && !(m.deletedFor || []).includes(req.user.id)).map((m) => ({ ...m, deliveredTo: m.deliveredTo || [], readBy: m.readBy || [], deletedFor: m.deletedFor || [], sender: publicUser(db.users.find((u) => u.id === m.senderId)) }))); });
app.post('/api/chats/:chatId/messages', authorize, async (req, res) => {
  const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); const body = String(req.body.body || '').trim();
  if (!c) return res.status(404).json({ error: 'Chat not found.' }); if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const clientId = String(req.body.clientId || '').slice(0, 80);
  const existing = clientId && db.messages.find((m) => m.chatId === c.id && m.senderId === req.user.id && m.clientId === clientId);
  if (existing) return res.json({ ...existing, sender: publicUser(db.users.find((u) => u.id === existing.senderId)) });
  const message = { id: id(), clientId: clientId || null, chatId: c.id, senderId: req.user.id, body, createdAt: new Date().toISOString(), deliveredTo: c.memberIds.filter((memberId) => memberId !== req.user.id && onlineUsers.has(memberId)), readBy: [], deletedFor: [] }; db.messages.push(message); await save();
  const result = { ...message, sender: publicUser(getUser(req)) }; io.to(`chat:${c.id}`).emit('message:new', result); res.status(201).json(result);
});
app.delete('/api/chats/:chatId/messages/:messageId', authorize, async (req, res) => {
  const chat = db.chats.find((item) => item.id === req.params.chatId && item.memberIds.includes(req.user.id));
  const message = db.messages.find((item) => item.id === req.params.messageId && item.chatId === req.params.chatId);
  if (!chat || !message) return res.status(404).json({ error: 'Message not found.' });
  const scope = req.body?.scope;
  if (scope === 'me') {
    message.deletedFor ||= [];
    if (!message.deletedFor.includes(req.user.id)) message.deletedFor.push(req.user.id);
    await save();
    io.to(`user:${req.user.id}`).emit('message:deleted', { chatId: chat.id, messageId: message.id, scope: 'me', userId: req.user.id });
    return res.json({ ok: true });
  }
  if (scope !== 'everyone') return res.status(400).json({ error: 'Choose whether to delete the message for you or everyone.' });
  if (message.senderId !== req.user.id) return res.status(403).json({ error: 'Only the sender can delete a message for everyone.' });
  if (!message.deletedForEveryone) { message.deletedForEveryone = true; message.deletedAt = new Date().toISOString(); message.body = ''; await save(); }
  const payload = { chatId: chat.id, messageId: message.id, scope: 'everyone', message: { ...message, sender: publicUser(db.users.find((user) => user.id === message.senderId)) } };
  io.to(`chat:${chat.id}`).emit('message:deleted', payload);
  res.json({ ok: true });
});
app.post('/api/chats/:chatId/files', authorize, (req, res, next) => { if (!db.chats.some((chat) => chat.id === req.params.chatId && chat.memberIds.includes(req.user.id))) return res.status(404).json({ error: 'Chat not found.' }); next(); }, upload.single('file'), async (req, res) => {
  const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c || !req.file) return res.status(400).json({ error: 'A chat and file are required.' });
  const file = { id: id(), chatId: c.id, senderId: req.user.id, senderName: getUser(req).name, name: req.file.originalname, type: req.file.mimetype, size: req.file.size, storageName: req.file.filename, createdAt: new Date().toISOString() }; db.files.push(file); await save(); io.to(`chat:${c.id}`).emit('file:new', { ...file, url: undefined }); res.status(201).json({ ...file, url: mediaUrl(file, req.user.id) });
});
app.get('/api/chats/:chatId/files', authorize, (req, res) => { const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c) return res.status(404).json({ error: 'Chat not found.' }); res.json(db.files.filter((f) => f.chatId === c.id).map((file) => ({ ...file, url: mediaUrl(file, req.user.id) }))); });
app.post('/api/chats/:chatId/report', authorize, async (req, res) => { const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c) return res.status(404).json({ error: 'Chat not found.' }); db.reports.push({ id: id(), chatId: c.id, reporterId: req.user.id, reason: String(req.body.reason || '').trim(), createdAt: new Date().toISOString(), status: 'open' }); await save(); res.status(201).json({ ok: true }); });

app.get('/api/admin/summary', authorize, admin, (req,res) => res.json({ users: db.users.length, online: onlineUsers.size, chats: db.chats.length, messages: db.messages.length, reports: db.reports.filter((r) => r.status === 'open').length }));
app.get('/api/admin/users', authorize, admin, (req,res) => res.json(db.users.map(publicUser)));
app.delete('/api/admin/users/:id', authorize, admin, async (req,res) => { if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' }); db.users = db.users.filter((u) => u.id !== req.params.id); db.chats = db.chats.filter((c) => !c.memberIds.includes(req.params.id)); await save(); res.status(204).end(); });
app.get('/api/admin/reports', authorize, admin, (req,res) => res.json(db.reports));
app.get('/api/admin/settings', authorize, admin, (req,res) => res.json(db.settings));
app.patch('/api/admin/settings', authorize, admin, async (req,res) => { db.settings = { ...db.settings, ...req.body }; await save(); res.json(db.settings); });

io.use((socket, next) => { try { socket.user = jwt.verify(socket.handshake.auth.token, secret); next(); } catch { next(new Error('Unauthorized')); } });
io.on('connection', (socket) => {
  const uid = socket.user.id;
  const wasOffline = !onlineUsers.has(uid);
  onlineUsers.set(uid, (onlineUsers.get(uid) || 0) + 1);
  socket.join(`user:${uid}`);
  if (wasOffline) emitPresence(uid);
  db.chats.filter((c) => c.memberIds.includes(uid)).forEach((c) => socket.join(`chat:${c.id}`));
  socket.on('chat:join', ({ chatId }) => { if (socketChat(socket, chatId)) socket.join(`chat:${chatId}`); });
  socket.on('typing', ({ chatId, active }) => { if (socketChat(socket, chatId)) socket.to(`chat:${chatId}`).emit('typing', { chatId, userId: uid, active: !!active }); });
  socket.on('messages:read', async ({ chatId, messageIds }) => {
    const chat = socketChat(socket, chatId); if (!chat || !Array.isArray(messageIds)) return;
    const requested = new Set(messageIds.slice(0, 200).map(String)); const changed = [];
    for (const message of db.messages) {
      if (message.chatId !== chatId || message.senderId === uid || !requested.has(message.id) || (message.deletedFor || []).includes(uid)) continue;
      message.deliveredTo ||= []; message.readBy ||= [];
      let touched = false;
      if (!message.deliveredTo.includes(uid)) { message.deliveredTo.push(uid); touched = true; }
      if (!message.readBy.includes(uid)) { message.readBy.push(uid); touched = true; }
      if (touched) changed.push(message);
    }
    if (!changed.length) return;
    await save();
    changed.forEach((message) => io.to(`user:${message.senderId}`).emit('message:status', { chatId, messageId: message.id, deliveredTo: message.deliveredTo, readBy: message.readBy }));
  });
  socket.on('call:offer', async ({ chatId, callId: requestedCallId, offer, video, targetId }) => {
    const c = socketChat(socket, chatId); if (!c || !c.memberIds.includes(targetId) || targetId === uid || !offer) return;
    const callId = String(requestedCallId || id()); const payload = { callId, chatId, offer, video: !!video, from: publicUser(db.users.find((u) => u.id === uid)) };
    const pending = { toUserId: targetId, payload, expiresAt: Date.now() + 45000, iceCandidates: [] };
    pendingCalls.set(callId, pending); setTimeout(() => { if (pendingCalls.get(callId) === pending) pendingCalls.delete(callId); }, 45000);
    io.to(`user:${targetId}`).emit('call:incoming', payload);
    await pushToUser(targetId, { callId, chatId, from: payload.from.name, video: !!video }, 45);
  });
  socket.on('call:answer', async ({ chatId, callId, answer, targetId }) => { const c = socketChat(socket, chatId); if (c?.memberIds.includes(targetId)) { const pending = callId && pendingCalls.get(callId); if (pending) { pending.iceCandidates.forEach((candidate) => socket.emit('call:ice', { chatId, callId, candidate, from: targetId })); pendingCalls.delete(callId); } io.to(`user:${targetId}`).emit('call:answer', { chatId, callId, answer, from: uid }); socket.to(`user:${uid}`).emit('call:answered-elsewhere', { chatId, callId, from: targetId }); await pushToUser(uid, { callId, dismissed: true }); } });
  socket.on('call:ice', ({ chatId, callId, candidate, targetId }) => { const c = socketChat(socket, chatId); if (!c?.memberIds.includes(targetId)) return; const pending = callId && pendingCalls.get(callId); if (pending && pending.payload.from.id === uid && pending.toUserId === targetId) pending.iceCandidates.push(candidate); else io.to(`user:${targetId}`).emit('call:ice', { chatId, callId, candidate, from: uid }); });
  socket.on('call:end', async ({ chatId, callId, targetId }) => { const c = socketChat(socket, chatId); if (!c?.memberIds.includes(targetId)) return; const pending = callId && pendingCalls.get(callId); if (pending?.toUserId === uid) { pendingCalls.delete(callId); socket.to(`user:${uid}`).emit('call:answered-elsewhere', { chatId, callId, from: pending.payload.from.id }); io.to(`user:${targetId}`).emit('call:end', { chatId, callId, from: uid }); await Promise.all([pushToUser(uid, { callId, dismissed: true }), pushToUser(targetId, { callId, dismissed: true })]); } else { if (callId) pendingCalls.delete(callId); io.to(`user:${targetId}`).emit('call:end', { chatId, callId, from: uid }); await pushToUser(targetId, { callId, dismissed: true }); } });
  socket.on('group-call:start', async ({ chatId, callId: requestedCallId, video }) => {
    const chat = socketChat(socket, chatId); if (!chat?.isGroup || chat.memberIds.length < 2) return socket.emit('group-call:error', { message: 'Group calls need a valid group chat.' });
    const activeId = activeGroupCallsByChat.get(chatId); const activeCall = activeId && groupCalls.get(activeId);
    if (activeCall) return socket.emit('group-call:already-active', groupCallView(activeCall));
    const callId = String(requestedCallId || id()); const groupCall = { id: callId, chatId, name: chat.name, hostId: uid, video: !!video, participants: new Map([[uid, socket.id]]), createdAt: Date.now() };
    groupCalls.set(callId, groupCall); activeGroupCallsByChat.set(chatId, callId); socket.join(groupCallRoom(callId));
    socket.emit('group-call:participants', { callId, participants: [] });
    const payload = { type: 'group', callId, chatId, video: groupCall.video, groupName: chat.name, from: publicUser(db.users.find((user) => user.id === uid)) };
    await Promise.all(chat.memberIds.filter((memberId) => memberId !== uid).map(async (memberId) => {
      io.to(`user:${memberId}`).emit('group-call:incoming', payload);
      await pushToUser(memberId, { callId, chatId, from: payload.from.name, groupName: chat.name, video: groupCall.video, group: true }, 45);
    }));
  });
  socket.on('group-call:join', async ({ callId }) => {
    const groupCall = groupCalls.get(callId); const chat = groupCall && socketChat(socket, groupCall.chatId);
    if (!groupCall || !chat?.isGroup) return socket.emit('group-call:error', { callId, message: 'This group call has ended.' });
    if (groupCall.participants.has(uid)) return socket.emit('group-call:error', { callId, message: 'Your account is already connected to this group call on another device.' });
    if (groupCall.participants.size >= 6) return socket.emit('group-call:error', { callId, message: 'This group call has reached its six-person limit.' });
    const participants = groupCallView(groupCall).participants;
    groupCall.participants.set(uid, socket.id); socket.join(groupCallRoom(callId));
    socket.emit('group-call:participants', { callId, participants });
    io.to(groupCallRoom(callId)).emit('group-call:participant-joined', { callId, participant: publicUser(db.users.find((user) => user.id === uid)) });
    socket.to(`user:${uid}`).emit('group-call:answered-elsewhere', { callId });
    await pushToUser(uid, { callId, dismissed: true });
  });
  socket.on('group-call:decline', async ({ callId }) => { const groupCall = groupCalls.get(callId); const chat = groupCall && socketChat(socket, groupCall.chatId); if (!chat?.isGroup || groupCall.participants.has(uid)) return; socket.to(`user:${uid}`).emit('group-call:answered-elsewhere', { callId }); io.to(groupCallRoom(callId)).emit('group-call:declined', { callId, user: publicUser(db.users.find((user) => user.id === uid)) }); await pushToUser(uid, { callId, dismissed: true }); });
  socket.on('group-call:offer', ({ callId, targetId, offer }) => { const groupCall = groupCalls.get(callId); const chat = groupCall && socketChat(socket, groupCall.chatId); const targetSocketId = groupCall?.participants.get(targetId); if (chat?.isGroup && groupCall.participants.get(uid) === socket.id && targetSocketId && targetId !== uid) io.to(targetSocketId).emit('group-call:offer', { callId, from: uid, offer }); });
  socket.on('group-call:answer', ({ callId, targetId, answer }) => { const groupCall = groupCalls.get(callId); const chat = groupCall && socketChat(socket, groupCall.chatId); const targetSocketId = groupCall?.participants.get(targetId); if (chat?.isGroup && groupCall.participants.get(uid) === socket.id && targetSocketId) io.to(targetSocketId).emit('group-call:answer', { callId, from: uid, answer }); });
  socket.on('group-call:ice', ({ callId, targetId, candidate }) => { const groupCall = groupCalls.get(callId); const chat = groupCall && socketChat(socket, groupCall.chatId); const targetSocketId = groupCall?.participants.get(targetId); if (chat?.isGroup && groupCall.participants.get(uid) === socket.id && targetSocketId) io.to(targetSocketId).emit('group-call:ice', { callId, from: uid, candidate }); });
  socket.on('group-call:leave', ({ callId }) => { const groupCall = groupCalls.get(callId); if (!groupCall || groupCall.participants.get(uid) !== socket.id) return; socket.leave(groupCallRoom(callId)); removeGroupCallParticipant(groupCall, uid); });
  socket.on('disconnect', async () => { for (const groupCall of groupCalls.values()) if (groupCall.participants.get(uid) === socket.id) removeGroupCallParticipant(groupCall, uid); const n = (onlineUsers.get(uid) || 1) - 1; if (n) onlineUsers.set(uid, n); else { onlineUsers.delete(uid); const u = db.users.find((x) => x.id === uid); if (u) { u.lastSeen = new Date().toISOString(); await save(); } emitPresence(uid); } });
});

async function start() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS whispr_state (id INTEGER PRIMARY KEY CHECK (id = 1), state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const { rows } = await pool.query('SELECT state FROM whispr_state WHERE id = 1');
    if (rows[0]) db = rows[0].state;
    else await pool.query('INSERT INTO whispr_state (id, state) VALUES (1, $1::jsonb)', [JSON.stringify(db)]);
    db.pushSubscriptions ||= [];
    console.log('Persistent PostgreSQL storage is active.');
  } else if (process.env.NODE_ENV === 'production') {
    console.warn('DATABASE_URL is not set. Data is using local JSON storage and may be lost on redeploy.');
  }
  server.listen(process.env.PORT || 3000, () => console.log(`Whispr is running on port ${process.env.PORT || 3000}`));
}
start().catch((error) => { console.error('Whispr failed to start:', error); process.exit(1); });
