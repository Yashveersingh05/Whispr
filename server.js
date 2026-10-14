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

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const uploadDir = path.join(root, 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
const dbPath = path.join(dataDir, 'whispr.json');
const secret = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: uploadDir, limits: { fileSize: 25 * 1024 * 1024 } });

const blank = () => ({ users: [], chats: [], messages: [], files: [], reports: [], settings: { registrationOpen: true } });
let db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : blank();
const save = () => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
const id = () => crypto.randomUUID();
const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar || null, role: u.role, createdAt: u.createdAt, online: onlineUsers.has(u.id), lastSeen: u.lastSeen || null });
const onlineUsers = new Map();
const tokenFor = (u) => jwt.sign({ id: u.id }, secret, { expiresIn: '7d' });
const getUser = (req) => db.users.find((u) => u.id === req.user.id);
const members = (chat) => chat.memberIds.map((memberId) => db.users.find((u) => u.id === memberId)).filter(Boolean);
const peer = (chat, userId) => members(chat).find((u) => u.id !== userId);
function chatView(chat, userId) {
  const last = db.messages.filter((m) => m.chatId === chat.id).at(-1);
  const other = peer(chat, userId);
  return { ...chat, participants: members(chat).map(publicUser), title: chat.isGroup ? chat.name : other?.name || 'Unknown user', avatar: chat.isGroup ? null : other?.avatar || null, online: !chat.isGroup && !!other && onlineUsers.has(other.id), lastMessage: last || null };
}
function authorize(req, res, next) {
  const raw = req.headers.authorization?.replace('Bearer ', '');
  try { req.user = jwt.verify(raw, secret); next(); } catch { res.status(401).json({ error: 'Please sign in again.' }); }
}
function admin(req, res, next) { const u = getUser(req); if (u?.role === 'admin') next(); else res.status(403).json({ error: 'Admin access required.' }); }
function emitPresence(userId) { io.emit('presence', { userId, online: onlineUsers.has(userId) }); }

app.use(express.json());
app.use('/uploads', express.static(uploadDir));
app.use(express.static(root));
app.get('/', (req, res) => res.sendFile(path.join(root, 'login.html')));

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!db.settings.registrationOpen) return res.status(403).json({ error: 'Registration is currently closed.' });
  if (!name?.trim() || !email?.trim() || !password || password.length < 8) return res.status(400).json({ error: 'Name, email, and an 8-character password are required.' });
  if (db.users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) return res.status(409).json({ error: 'An account already uses that email.' });
  const user = { id: id(), name: name.trim(), email: email.trim().toLowerCase(), password: await bcrypt.hash(password, 12), role: db.users.length === 0 ? 'admin' : 'member', createdAt: new Date().toISOString(), lastSeen: null };
  db.users.push(user); save(); res.status(201).json({ token: tokenFor(user), user: publicUser(user) });
});
app.post('/api/auth/login', async (req, res) => {
  const user = db.users.find((u) => u.email === String(req.body.email || '').trim().toLowerCase());
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) return res.status(401).json({ error: 'Incorrect email or password.' });
  res.json({ token: tokenFor(user), user: publicUser(user) });
});
app.get('/api/me', authorize, (req, res) => res.json(publicUser(getUser(req))));
app.patch('/api/me', authorize, (req, res) => { const u = getUser(req); const name = String(req.body.name || '').trim(); if (!name) return res.status(400).json({ error: 'Name is required.' }); u.name = name; save(); res.json(publicUser(u)); });

app.get('/api/users', authorize, (req, res) => { const q = String(req.query.q || '').toLowerCase(); res.json(db.users.filter((u) => u.id !== req.user.id && (!q || u.name.toLowerCase().includes(q) || u.email.includes(q))).map(publicUser)); });
app.get('/api/chats', authorize, (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const list = db.chats.filter((c) => c.memberIds.includes(req.user.id)).map((c) => chatView(c, req.user.id)).filter((c) => !q || c.title.toLowerCase().includes(q)).sort((a,b) => new Date(b.lastMessage?.createdAt || b.createdAt) - new Date(a.lastMessage?.createdAt || a.createdAt));
  res.json(list);
});
app.post('/api/chats', authorize, (req, res) => {
  const ids = [...new Set([req.user.id, ...(req.body.memberIds || [])])];
  if (ids.length < 2 || ids.some((x) => !db.users.some((u) => u.id === x))) return res.status(400).json({ error: 'Select at least one valid person.' });
  const isGroup = ids.length > 2 || !!String(req.body.name || '').trim();
  let chat = !isGroup && db.chats.find((c) => !c.isGroup && c.memberIds.length === 2 && ids.every((x) => c.memberIds.includes(x)));
  if (!chat) { chat = { id: id(), memberIds: ids, isGroup, name: isGroup ? String(req.body.name || '').trim() || 'Untitled group' : null, createdAt: new Date().toISOString() }; db.chats.push(chat); save(); }
  res.status(201).json(chatView(chat, req.user.id));
});
app.get('/api/chats/:chatId/messages', authorize, (req, res) => { const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c) return res.status(404).json({ error: 'Chat not found.' }); res.json(db.messages.filter((m) => m.chatId === c.id).map((m) => ({ ...m, sender: publicUser(db.users.find((u) => u.id === m.senderId)) }))); });
app.post('/api/chats/:chatId/messages', authorize, (req, res) => {
  const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); const body = String(req.body.body || '').trim();
  if (!c) return res.status(404).json({ error: 'Chat not found.' }); if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const message = { id: id(), chatId: c.id, senderId: req.user.id, body, createdAt: new Date().toISOString() }; db.messages.push(message); save();
  const result = { ...message, sender: publicUser(getUser(req)) }; io.to(`chat:${c.id}`).emit('message:new', result); res.status(201).json(result);
});
app.post('/api/chats/:chatId/files', authorize, upload.single('file'), (req, res) => {
  const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c || !req.file) return res.status(400).json({ error: 'A chat and file are required.' });
  const file = { id: id(), chatId: c.id, senderId: req.user.id, name: req.file.originalname, type: req.file.mimetype, size: req.file.size, url: `/uploads/${req.file.filename}`, createdAt: new Date().toISOString() }; db.files.push(file); save(); io.to(`chat:${c.id}`).emit('file:new', file); res.status(201).json(file);
});
app.post('/api/chats/:chatId/report', authorize, (req, res) => { const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c) return res.status(404).json({ error: 'Chat not found.' }); db.reports.push({ id: id(), chatId: c.id, reporterId: req.user.id, reason: String(req.body.reason || '').trim(), createdAt: new Date().toISOString(), status: 'open' }); save(); res.status(201).json({ ok: true }); });

app.get('/api/admin/summary', authorize, admin, (req,res) => res.json({ users: db.users.length, online: onlineUsers.size, chats: db.chats.length, messages: db.messages.length, reports: db.reports.filter((r) => r.status === 'open').length }));
app.get('/api/admin/users', authorize, admin, (req,res) => res.json(db.users.map(publicUser)));
app.delete('/api/admin/users/:id', authorize, admin, (req,res) => { if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' }); db.users = db.users.filter((u) => u.id !== req.params.id); db.chats = db.chats.filter((c) => !c.memberIds.includes(req.params.id)); save(); res.status(204).end(); });
app.get('/api/admin/reports', authorize, admin, (req,res) => res.json(db.reports));
app.get('/api/admin/settings', authorize, admin, (req,res) => res.json(db.settings));
app.patch('/api/admin/settings', authorize, admin, (req,res) => { db.settings = { ...db.settings, ...req.body }; save(); res.json(db.settings); });

io.use((socket, next) => { try { socket.user = jwt.verify(socket.handshake.auth.token, secret); next(); } catch { next(new Error('Unauthorized')); } });
io.on('connection', (socket) => { const uid = socket.user.id; const wasOffline = !onlineUsers.has(uid); onlineUsers.set(uid, (onlineUsers.get(uid) || 0) + 1); if (wasOffline) emitPresence(uid); db.chats.filter((c) => c.memberIds.includes(uid)).forEach((c) => socket.join(`chat:${c.id}`)); socket.on('typing', ({ chatId, active }) => socket.to(`chat:${chatId}`).emit('typing', { chatId, userId: uid, active: !!active })); socket.on('disconnect', () => { const n = (onlineUsers.get(uid) || 1) - 1; if (n) onlineUsers.set(uid, n); else { onlineUsers.delete(uid); const u = db.users.find((x) => x.id === uid); if (u) { u.lastSeen = new Date().toISOString(); save(); } emitPresence(uid); } }); });

server.listen(process.env.PORT || 3000, () => console.log(`Whispr is running on http://localhost:${process.env.PORT || 3000}`));
