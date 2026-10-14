import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';

const dataDirectory = await mkdtemp(path.join(tmpdir(), 'whispr-smoke-'));
const port = 32000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), JWT_SECRET: 'smoke-test-only-secret', DB_FILE: path.join(dataDirectory, 'state.json') }, stdio: 'ignore' });
let aliceSocket;
let bobSocket;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const waitFor = (socket, event) => new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 5000); socket.once(event, (value) => { clearTimeout(timeout); resolve(value); }); });
const waitForServer = async () => { for (let attempt = 0; attempt < 60; attempt += 1) { try { if ((await fetch(origin)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('Server did not start'); };
const request = async (url, token, options = {}) => { const response = await fetch(`${origin}${url}`, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } }); const data = response.status === 204 ? null : await response.json(); assert(response.ok, data?.error || `${url} returned ${response.status}`); return data; };

try {
  await waitForServer();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const alice = await request('/api/auth/register', null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Smoke Alice', email: `alice-${tag}@example.test`, password: 'smoke-pass-123' }) });
  const bob = await request('/api/auth/register', null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Smoke Bob', email: `bob-${tag}@example.test`, password: 'smoke-pass-123' }) });
  aliceSocket = connect(origin, { auth: { token: alice.token }, reconnection: false });
  bobSocket = connect(origin, { auth: { token: bob.token }, reconnection: false });
  await Promise.all([waitFor(aliceSocket, 'connect'), waitFor(bobSocket, 'connect')]);
  const chat = await request('/api/chats', alice.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberIds: [bob.user.id] }) });

  const messageReceived = waitFor(bobSocket, 'message:new');
  await request(`/api/chats/${chat.id}/messages`, alice.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'live delivery' }) });
  assert((await messageReceived).body === 'live delivery', 'new chat message did not reach the other participant');

  const incomingCall = waitFor(bobSocket, 'call:incoming');
  aliceSocket.emit('call:offer', { chatId: chat.id, targetId: bob.user.id, video: true, offer: { type: 'offer', sdp: 'smoke' } });
  assert((await incomingCall).from.id === alice.user.id, 'call offer did not reach the other participant');
  const answered = waitFor(aliceSocket, 'call:answer');
  bobSocket.emit('call:answer', { chatId: chat.id, targetId: alice.user.id, answer: { type: 'answer', sdp: 'smoke' } });
  assert((await answered).from === bob.user.id, 'call answer did not return to caller');
  const ice = waitFor(aliceSocket, 'call:ice');
  bobSocket.emit('call:ice', { chatId: chat.id, targetId: alice.user.id, candidate: { candidate: 'smoke' } });
  assert((await ice).candidate.candidate === 'smoke', 'ICE candidate did not reach caller');
  await request('/api/me', alice.token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Smoke Alice Updated', bio: 'Available for testing' }) });
  const profile = await request('/api/me', alice.token);
  assert(profile.bio === 'Available for testing', 'profile changes were not persisted');
  assert(Array.isArray((await request('/api/rtc-config', alice.token)).iceServers), 'RTC configuration is not available');
  console.log('PASS: auth, profile persistence, chat creation, realtime messages, call offer/answer/ICE routing, and RTC configuration');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  aliceSocket?.close();
  bobSocket?.close();
  child.kill();
  await rm(dataDirectory, { recursive: true, force: true });
}
