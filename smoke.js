import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';

const dataDirectory = await mkdtemp(path.join(tmpdir(), 'whispr-smoke-'));
const port = 32000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), JWT_SECRET: 'smoke-test-only-secret', DB_FILE: path.join(dataDirectory, 'state.json'), UPLOAD_DIR: path.join(dataDirectory, 'uploads') }, stdio: 'ignore' });
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
  const messageOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'live delivery', clientId: 'smoke-message-once' }) };
  const sentMessage = await request(`/api/chats/${chat.id}/messages`, alice.token, messageOptions);
  assert((await messageReceived).body === 'live delivery', 'new chat message did not reach the other participant');
  const retriedMessage = await request(`/api/chats/${chat.id}/messages`, alice.token, messageOptions);
  assert(retriedMessage.id === sentMessage.id, 'retrying a message created a duplicate');

  const fileReceived = waitFor(bobSocket, 'file:new');
  const upload = new FormData();
  upload.append('file', new Blob(['image fixture'], { type: 'image/png' }), 'preview.png');
  const uploaded = await request(`/api/chats/${chat.id}/files`, alice.token, { method: 'POST', body: upload });
  assert((await fileReceived).id === uploaded.id, 'uploaded media did not reach the other participant in realtime');
  const shared = (await request(`/api/chats/${chat.id}/files`, bob.token)).find((file) => file.id === uploaded.id);
  assert(shared?.url, 'shared media list did not return a signed media URL');
  const mediaResponse = await fetch(new URL(shared.url, origin));
  assert(mediaResponse.ok, 'signed media could not be downloaded by a chat member');
  assert(mediaResponse.headers.get('content-type')?.startsWith('image/png'), 'uploaded media did not preserve its MIME type');
  assert((await fetch(new URL(`/media/${uploaded.id}?token=invalid`, origin))).status === 401, 'invalid media signatures were not rejected');
  const group = await request('/api/chats', alice.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberIds: [bob.user.id], isGroup: true, name: 'Smoke group' }) });
  assert(group.isGroup && group.title === 'Smoke group', 'group chat creation failed');
  assert((await fetch(`${origin}/data/whispr.json`)).status === 404, 'private application state is publicly exposed');

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
  console.log('PASS: auth, profile persistence, direct and group chat creation, realtime messages, idempotent retries, signed media, call signaling, and RTC configuration');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  aliceSocket?.close();
  bobSocket?.close();
  child.kill();
  await rm(dataDirectory, { recursive: true, force: true });
}
