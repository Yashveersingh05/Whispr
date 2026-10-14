const token = localStorage.getItem('whispr_token');
if (!token) location.replace('login.html');
const $ = (selector) => document.querySelector(selector);
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const initials = (name = '?') => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const clock = (value) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
const api = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (response.status === 401) { localStorage.removeItem('whispr_token'); location.replace('login.html'); throw new Error('Your session expired.'); }
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.error || 'Request failed.');
  return result;
};

let me, chats = [], activeChat = null, selectedUsers = [], call = null, voiceRecorder = null, voiceStream = null, voiceChunks = [];
const earlyIce = new Map();
const socket = io({ auth: { token }, reconnection: true, reconnectionAttempts: Infinity });
socket.on('connect_error', (error) => { if (/unauthorized/i.test(error.message)) { localStorage.removeItem('whispr_token'); location.replace('login.html'); } else toast('Live connection lost. Retrying…', 'error'); });
socket.on('connect', () => {
  if (!me) return;
  loadChats().then(() => activeChat && openChat(activeChat.id)).catch(() => toast('Could not sync the latest messages.', 'error'));
});

function avatarMarkup(user) { return user?.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(initials(user?.name || user?.title)); }
function toast(message, kind = '') {
  let node = $('#toast');
  if (!node) { node = document.createElement('div'); node.id = 'toast'; node.setAttribute('role', 'status'); document.body.append(node); }
  node.textContent = message; node.className = kind; node.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 5000);
}
function renderChats() {
  const query = $('#chat-search').value.trim().toLocaleLowerCase();
  const visible = chats.filter((chat) => (query === '' || chat.title.toLocaleLowerCase().includes(query) || chat.lastMessage?.body.toLocaleLowerCase().includes(query)) && (window.chatFilter !== 'online' || chat.online));
  $('#chat-list').innerHTML = visible.length ? visible.map((chat) => `<button class="chat-item ${chat.id === activeChat?.id ? 'active' : ''}" data-chat-id="${esc(chat.id)}"><span class="chat-item-avatar"><span class="avatar-ph">${avatarMarkup({ name: chat.title, avatar: chat.avatar })}</span><i class="status-dot ${chat.online ? 'online' : 'away'}"></i></span><span class="chat-item-body"><span class="chat-item-top"><b>${esc(chat.title)}</b><small>${chat.lastMessage ? clock(chat.lastMessage.createdAt) : ''}</small></span><span class="chat-item-bottom"><span class="chat-preview">${esc(chat.lastMessage?.body || 'No messages yet')}</span></span></span></button>`).join('') : '<p class="list-empty">No conversations match.</p>';
  document.querySelectorAll('[data-chat-id]').forEach((button) => button.addEventListener('click', () => openChat(button.dataset.chatId)));
}
async function loadChats() {
  chats = await api('/api/chats');
  if (activeChat) activeChat = chats.find((chat) => chat.id === activeChat.id) || null;
  renderChats();
}
function renderHeader() {
  if (!activeChat) return;
  const other = activeChat.participants.find((participant) => participant.id !== me.id);
  $('#chat-header').innerHTML = `<button class="back-button" id="back-to-chats" aria-label="Back to chats">‹</button><span class="chat-main-who"><span class="chat-item-avatar"><span class="avatar-ph">${avatarMarkup(other || { name: activeChat.title })}</span><i class="status-dot ${activeChat.online ? 'online' : 'away'}"></i></span><span><b class="chat-main-name">${esc(activeChat.title)}</b><small class="chat-main-status">${activeChat.isGroup ? `${activeChat.participants.length} members` : activeChat.online ? 'Online' : 'Offline'}</small></span></span><span class="chat-main-actions"><button class="icon-btn-round" id="voice-call" aria-label="Start voice call" ${activeChat.isGroup ? 'hidden' : ''}><i class="fa-solid fa-phone"></i></button><button class="icon-btn-round" id="video-call" aria-label="Start video call" ${activeChat.isGroup ? 'hidden' : ''}><i class="fa-solid fa-video"></i></button><button class="icon-btn-round" id="chat-info" aria-label="Conversation info"><i class="fa-solid fa-circle-info"></i></button></span>`;
  $('#message-input').disabled = $('#file-button').disabled = $('#voice-record').disabled = $('#emoji-toggle').disabled = $('.send-btn').disabled = $('#report').disabled = false;
  $('#back-to-chats').onclick = () => $('.chat-shell').classList.remove('chat-open');
  $('#voice-call').onclick = () => startCall(false);
  $('#video-call').onclick = () => startCall(true);
  $('#chat-info').onclick = () => $('.chat-profile').classList.toggle('mobile-visible');
}
function renderMessage(message) {
  const mine = message.senderId === me.id;
  const clientData = message.clientId ? `data-client-id="${esc(message.clientId)}"` : '';
  return `<article class="msg-row ${mine ? 'mine' : ''}" data-message-id="${esc(message.id || '')}" ${clientData}><div class="msg-bubble ${mine ? 'mine' : ''}"><div class="msg-meta"><b>${mine ? 'You' : esc(message.sender?.name || activeChat.title)}</b><time>${clock(message.createdAt)}</time></div><div class="message-text">${esc(message.body)}</div>${message.pending ? '<small class="delivery-state">Sending…</small>' : mine ? '<small class="delivery-state">Sent ✓</small>' : ''}</div></article>`;
}
function renderFileMessage(file) {
  const mine = file.senderId === me.id;
  const preview = file.type.startsWith('image/') ? `<a href="${esc(file.url)}" target="_blank" rel="noopener"><img class="inline-image" src="${esc(file.url)}" alt="${esc(file.name)}"></a>`
    : file.type.startsWith('video/') ? `<video class="inline-video" src="${esc(file.url)}" controls preload="metadata"></video>`
      : file.type.startsWith('audio/') ? `<audio class="inline-audio" src="${esc(file.url)}" controls preload="metadata"></audio>`
        : `<a class="inline-document" href="${esc(file.url)}" target="_blank" rel="noopener" download><i class="fa-solid fa-file-arrow-down"></i><span>${esc(file.name)}<small>${(file.size / 1024).toFixed(0)} KB</small></span></a>`;
  return `<article class="msg-row file-message ${mine ? 'mine' : ''}" data-file-id="${esc(file.id)}"><div class="msg-bubble ${mine ? 'mine' : ''}"><div class="msg-meta"><b>${mine ? 'You' : esc(file.senderName || activeChat.title)}</b><time>${clock(file.createdAt)}</time></div>${preview}<div class="attachment-name">${esc(file.name)}</div></div></article>`;
}
function appendMessage(node, key, value) {
  const current = $(`#messages [${key}="${CSS.escape(value)}"]`);
  if (current) return current;
  $('#messages .empty-state')?.remove();
  $('#messages').insertAdjacentHTML('beforeend', node);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return $(`#messages [${key}="${CSS.escape(value)}"]`);
}
async function renderFiles(files = null) {
  files ||= await api(`/api/chats/${activeChat.id}/files`);
  $('#files').innerHTML = files.length ? files.map((file) => file.type.startsWith('image/') ? `<a class="media-preview" href="${esc(file.url)}" target="_blank" rel="noopener"><img src="${esc(file.url)}" alt="${esc(file.name)}"></a>` : `<a class="file-link" href="${esc(file.url)}" target="_blank" rel="noopener" download>${esc(file.name)}</a>`).join('') : '<p class="profile-status">No shared files yet.</p>';
}
async function openChat(chatId) {
  activeChat = chats.find((chat) => chat.id === chatId);
  if (!activeChat) return;
  socket.emit('chat:join', { chatId });
  $('.chat-shell').classList.add('chat-open');
  $('.chat-profile').classList.remove('mobile-visible');
  renderHeader(); renderChats();
  const [messages, sharedFiles] = await Promise.all([api(`/api/chats/${chatId}/messages`), api(`/api/chats/${chatId}/files`)]);
  const timeline = [...messages.map((item) => ({ ...item, kind: 'message' })), ...sharedFiles.map((item) => ({ ...item, kind: 'file' }))].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  $('#messages').innerHTML = timeline.length ? timeline.map((item) => item.kind === 'file' ? renderFileMessage(item) : renderMessage(item)).join('') : '<p class="empty-state">Start the conversation.</p>';
  $('#messages').scrollTop = $('#messages').scrollHeight;
  const other = activeChat.participants.find((participant) => participant.id !== me.id);
  $('#conversation-info').innerHTML = `<span class="profile-avatar"><span class="avatar-ph">${avatarMarkup(other || { name: activeChat.title })}</span></span><p class="profile-name">${esc(activeChat.title)}</p><p class="profile-status">${esc(other?.bio || 'No about information')}</p><p class="profile-status">${activeChat.participants.map((person) => esc(person.name)).join(' · ')}</p>`;
  await renderFiles(sharedFiles);
}

$('#message-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const body = $('#message-input').value.trim(); if (!activeChat || !body) return;
  const chatId = activeChat.id, clientId = crypto.randomUUID(), createdAt = new Date().toISOString();
  $('#message-input').value = '';
  appendMessage(renderMessage({ id: `pending-${clientId}`, clientId, chatId, senderId: me.id, body, createdAt, pending: true }), 'data-client-id', clientId);
  try {
    const sent = await api(`/api/chats/${chatId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, clientId }) });
    const pending = $(`#messages [data-client-id="${CSS.escape(clientId)}"]`);
    if (pending) pending.outerHTML = renderMessage(sent);
  } catch (error) {
    const pending = $(`#messages [data-client-id="${CSS.escape(clientId)}"]`);
    pending?.classList.add('send-failed');
    pending?.querySelector('.delivery-state')?.replaceChildren(document.createTextNode('Not sent · retry by resending'));
    $('#message-input').value ||= body;
    toast(error.message, 'error');
  }
});
socket.on('message:new', (message) => {
  if (message.chatId === activeChat?.id) {
    const pending = message.clientId && $(`#messages [data-client-id="${CSS.escape(message.clientId)}"]`);
    if (pending) pending.outerHTML = renderMessage(message);
    else if (!$(`#messages [data-message-id="${CSS.escape(message.id)}"]`)) appendMessage(renderMessage(message), 'data-message-id', message.id);
  }
  loadChats().catch(() => {});
});
socket.on('file:new', async (file) => {
  if (file.chatId !== activeChat?.id) return;
  try { const files = await api(`/api/chats/${file.chatId}/files`); const saved = files.find((item) => item.id === file.id); if (saved) appendMessage(renderFileMessage(saved), 'data-file-id', saved.id); await renderFiles(files); }
  catch (error) { toast(`Attachment could not load: ${error.message}`, 'error'); }
});
socket.on('presence', ({ userId, online }) => { chats.forEach((chat) => { if (!chat.isGroup && chat.participants.some((person) => person.id === userId && person.id !== me.id)) chat.online = online; }); renderChats(); if (activeChat) { activeChat = chats.find((chat) => chat.id === activeChat.id); renderHeader(); } });
socket.on('typing', ({ chatId, userId, active }) => { if (chatId !== activeChat?.id || userId === me.id) return; let indicator = $('#typing-indicator'); if (active && !indicator) $('#messages').insertAdjacentHTML('beforeend', '<p class="typing" id="typing-indicator">Typing…</p>'); if (!active) indicator?.remove(); });
let typingTimer; $('#message-input').addEventListener('input', () => { if (!activeChat) return; socket.emit('typing', { chatId: activeChat.id, active: true }); clearTimeout(typingTimer); typingTimer = setTimeout(() => socket.emit('typing', { chatId: activeChat.id, active: false }), 1100); });

$('#chat-search').addEventListener('input', renderChats);
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { window.chatFilter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderChats(); }));
$('#logout').onclick = () => { localStorage.removeItem('whispr_token'); location.replace('login.html'); };
function updateGroupForm() { const isGroup = selectedUsers.length > 1; $('#group-name').hidden = $('#group-name-label').hidden = !isGroup; $('#create-chat').disabled = !selectedUsers.length; $('#create-chat').textContent = isGroup ? `Create group (${selectedUsers.length})` : 'Start chat'; }
$('#new-chat').onclick = () => { selectedUsers = []; $('#group-name').value = ''; $('#user-picker').value = ''; $('#user-results').innerHTML = ''; updateGroupForm(); $('#new-chat-dialog').showModal(); $('#user-picker').focus(); };
$('#user-picker').addEventListener('input', async () => { const users = await api(`/api/users?q=${encodeURIComponent($('#user-picker').value)}`); $('#user-results').innerHTML = users.map((user) => `<button type="button" class="user-option ${selectedUsers.some((item) => item.id === user.id) ? 'selected' : ''}" data-user-id="${esc(user.id)}" aria-pressed="${selectedUsers.some((item) => item.id === user.id)}">${esc(user.name)} <small>${esc(user.email)}</small></button>`).join('') || '<p>No registered users found.</p>'; document.querySelectorAll('[data-user-id]').forEach((button) => button.onclick = () => { const user = users.find((item) => item.id === button.dataset.userId); selectedUsers = selectedUsers.some((item) => item.id === user.id) ? selectedUsers.filter((item) => item.id !== user.id) : [...selectedUsers, user]; button.classList.toggle('selected', selectedUsers.some((item) => item.id === user.id)); button.setAttribute('aria-pressed', String(selectedUsers.some((item) => item.id === user.id))); updateGroupForm(); }); });
$('#new-chat-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!selectedUsers.length) return; const isGroup = selectedUsers.length > 1; try { const chat = await api('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberIds: selectedUsers.map((item) => item.id), isGroup, name: isGroup ? $('#group-name').value.trim() : '' }) }); $('#new-chat-dialog').close(); await loadChats(); await openChat(chat.id); } catch (error) { toast(error.message, 'error'); } });
const emojiSet = ['😀','😂','🥹','😍','🥳','👍','👎','❤️','🔥','🎉','🙏','👀','🤝','💯','✅','😭','😎','🙌','✨','💬'];
$('#emoji-picker').innerHTML = emojiSet.map((emoji) => `<button type="button" aria-label="Insert ${emoji}">${emoji}</button>`).join('');
$('#emoji-toggle').onclick = () => { $('#emoji-picker').hidden = !$('#emoji-picker').hidden; };
$('#emoji-picker').addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; const input = $('#message-input'); const start = input.selectionStart, end = input.selectionEnd; input.setRangeText(button.textContent, start, end, 'end'); input.focus(); input.dispatchEvent(new Event('input', { bubbles: true })); $('#emoji-picker').hidden = true; });
async function uploadAttachment(file, chatId = activeChat?.id) {
  if (!chatId) return;
  if (file.size > 25 * 1024 * 1024) { toast('Files must be smaller than 25 MB.', 'error'); return; }
  const data = new FormData(); data.append('file', file);
  const button = $('#file-button'); button.disabled = true; button.classList.add('uploading');
  try { const uploaded = await api(`/api/chats/${chatId}/files`, { method: 'POST', body: data }); if (activeChat?.id === chatId) { appendMessage(renderFileMessage(uploaded), 'data-file-id', uploaded.id); await renderFiles(); } }
  catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = !activeChat; button.classList.remove('uploading'); }
}
$('#file-button').onclick = () => activeChat && $('#file-input').click();
$('#file-input').addEventListener('change', async () => { const file = $('#file-input').files[0]; if (file && activeChat) await uploadAttachment(file, activeChat.id); $('#file-input').value = ''; });
$('#voice-record').onclick = async () => {
  if (voiceRecorder?.state === 'recording') { voiceRecorder.stop(); return; }
  if (!activeChat) return;
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const formats = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mimeType = formats.find((format) => MediaRecorder.isTypeSupported(format));
    voiceChunks = []; voiceRecorder = new MediaRecorder(voiceStream, mimeType ? { mimeType } : undefined);
    const chatId = activeChat.id; const button = $('#voice-record');
    button.classList.add('recording'); button.setAttribute('aria-label', 'Stop recording and send voice message'); toast('Recording voice message… press the microphone again to send.');
    voiceRecorder.ondataavailable = (event) => { if (event.data.size) voiceChunks.push(event.data); };
    voiceRecorder.onerror = () => { voiceStream?.getTracks().forEach((track) => track.stop()); button.classList.remove('recording'); toast('Voice recording failed.', 'error'); };
    voiceRecorder.onstop = async () => { const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' }); voiceStream?.getTracks().forEach((track) => track.stop()); voiceStream = null; button.classList.remove('recording'); if (blob.size) { const extension = blob.type.includes('mp4') ? 'm4a' : 'webm'; await uploadAttachment(new File([blob], `voice-message.${extension}`, { type: blob.type }), chatId); } };
    voiceRecorder.start();
  } catch (error) { voiceStream?.getTracks().forEach((track) => track.stop()); voiceStream = null; toast(error.name === 'NotAllowedError' ? 'Allow microphone access to record a voice message.' : error.message, 'error'); }
};
$('#report').onclick = async () => { if (!activeChat) return; const reason = prompt('Why are you reporting this conversation?'); if (reason === null) return; try { await api(`/api/chats/${activeChat.id}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); toast('Report sent.'); } catch (error) { toast(error.message, 'error'); } };

$('#profile-button').onclick = () => { $('#profile-name').value = me.name; $('#profile-bio').value = me.bio || ''; $('#avatar-input').value = ''; $('#profile-error').textContent = ''; $('#profile-dialog').showModal(); };
$('#profile-form').addEventListener('submit', async (event) => { event.preventDefault(); try { me = await api('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#profile-name').value, bio: $('#profile-bio').value }) }); const image = $('#avatar-input').files[0]; if (image) { const data = new FormData(); data.append('avatar', image); me = await api('/api/me/avatar', { method: 'POST', body: data }); } $('#profile-dialog').close(); $('#me-name').textContent = me.name; $('#me-bio').textContent = me.bio || 'Available'; $('#me-initial').innerHTML = avatarMarkup(me); await loadChats(); } catch (error) { $('#profile-error').textContent = error.message; } });

function stopCall(notify = true) { if (!call) return; clearTimeout(call.ringTimer); if (notify && call.peerId) socket.emit('call:end', { chatId: call.chatId, targetId: call.peerId }); call.stream?.getTracks().forEach((track) => track.stop()); call.pc?.close(); call = null; $('#local-video').srcObject = null; $('#remote-video').srcObject = null; if ($('#call-dialog').open) $('#call-dialog').close(); }
async function prepareCall(video) { if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Calls require HTTPS and a browser with camera/microphone support.'); const config = await api('/api/rtc-config'); const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video }); const pc = new RTCPeerConnection(config); call = { chatId: activeChat.id, peerId: null, stream, pc, pendingIce: [] }; $('#call-dialog').classList.toggle('audio-only', !video); $('#toggle-camera').hidden = !video; $('#toggle-camera').textContent = 'Camera off'; $('#toggle-mic').textContent = 'Mute'; stream.getTracks().forEach((track) => pc.addTrack(track, stream)); pc.ontrack = (event) => { $('#remote-video').srcObject = event.streams[0]; }; pc.onicecandidate = (event) => { if (event.candidate && call?.peerId) socket.emit('call:ice', { chatId: call.chatId, targetId: call.peerId, candidate: event.candidate }); }; pc.onconnectionstatechange = () => { if (pc.connectionState === 'connected') $('#call-title').textContent = 'Connected'; if (pc.connectionState === 'failed') toast('Call could not connect. Add a TURN service in deployment settings for this network.', 'error'); }; $('#local-video').srcObject = stream; $('#call-dialog').showModal(); }
async function startCall(video) { if (!activeChat || activeChat.isGroup) return toast('Calls are available in direct chats.', 'error'); if (!activeChat.online) return toast('This contact is offline right now.', 'error'); try { await prepareCall(video); const peer = activeChat.participants.find((person) => person.id !== me.id); call.peerId = peer.id; $('#call-title').textContent = `Calling ${peer.name}…`; call.ringTimer = setTimeout(() => { stopCall(); toast('No answer.'); }, 45000); const offer = await call.pc.createOffer(); await call.pc.setLocalDescription(offer); socket.emit('call:offer', { chatId: call.chatId, targetId: call.peerId, offer, video }); } catch (error) { stopCall(false); toast(error.name === 'NotAllowedError' ? 'Allow camera and microphone access in the browser, then try again.' : error.message, 'error'); } }
socket.on('call:incoming', async ({ chatId, offer, video, from }) => { const chat = chats.find((item) => item.id === chatId); if (!chat || call) return socket.emit('call:end', { chatId, targetId: from.id }); const answerCall = confirm(`${from.name} is calling. Answer?`); if (!answerCall) return socket.emit('call:end', { chatId, targetId: from.id }); try { activeChat = chat; await prepareCall(video); call.peerId = from.id; call.pendingIce = earlyIce.get(`${chatId}:${from.id}`) || []; earlyIce.delete(`${chatId}:${from.id}`); await call.pc.setRemoteDescription(offer); for (const candidate of call.pendingIce) await call.pc.addIceCandidate(candidate); call.pendingIce = []; const answer = await call.pc.createAnswer(); await call.pc.setLocalDescription(answer); socket.emit('call:answer', { chatId, targetId: from.id, answer }); $('#call-title').textContent = `In call with ${from.name}`; } catch (error) { stopCall(false); toast(error.message, 'error'); } });
socket.on('call:answer', async ({ chatId, answer, from }) => { if (!call || call.chatId !== chatId || call.peerId !== from) return; try { clearTimeout(call.ringTimer); await call.pc.setRemoteDescription(answer); for (const candidate of call.pendingIce) await call.pc.addIceCandidate(candidate); call.pendingIce = []; $('#call-title').textContent = 'Connecting…'; } catch (error) { toast(`Could not establish call: ${error.message}`, 'error'); stopCall(false); } });
socket.on('call:ice', async ({ chatId, candidate, from }) => { if (!call || call.chatId !== chatId || call.peerId !== from) { const key = `${chatId}:${from}`; earlyIce.set(key, [...(earlyIce.get(key) || []), candidate]); setTimeout(() => earlyIce.delete(key), 60000); return; } if (!call.pc.remoteDescription) call.pendingIce.push(candidate); else try { await call.pc.addIceCandidate(candidate); } catch (error) { console.warn('ICE candidate was rejected', error); } });
socket.on('call:end', ({ chatId, from }) => { if (call?.chatId === chatId && call.peerId === from) { stopCall(false); toast('Call ended.'); } });
$('#end-call').onclick = () => stopCall();
$('#toggle-mic').onclick = (event) => { const track = call?.stream.getAudioTracks()[0]; if (!track) return; track.enabled = !track.enabled; event.currentTarget.textContent = track.enabled ? 'Mute' : 'Unmute'; };
$('#toggle-camera').onclick = (event) => { const track = call?.stream.getVideoTracks()[0]; if (!track) return; track.enabled = !track.enabled; event.currentTarget.textContent = track.enabled ? 'Camera off' : 'Camera on'; };
$('#call-dialog').addEventListener('cancel', () => stopCall());
let swipeStart = null;
document.addEventListener('touchstart', (event) => { const touch = event.changedTouches[0]; swipeStart = { x: touch.clientX, y: touch.clientY }; }, { passive: true });
document.addEventListener('touchend', (event) => { if (!swipeStart || !$('.chat-shell').classList.contains('chat-open')) return; const touch = event.changedTouches[0]; const dx = touch.clientX - swipeStart.x; const dy = Math.abs(touch.clientY - swipeStart.y); if (swipeStart.x < 36 && dx > 90 && dy < 70) $('.chat-shell').classList.remove('chat-open'); swipeStart = null; }, { passive: true });

(async () => { try { me = await api('/api/me'); $('#me-name').textContent = me.name; $('#me-bio').textContent = me.bio || 'Available'; $('#me-initial').innerHTML = avatarMarkup(me); await loadChats(); } catch (error) { toast(error.message, 'error'); } })();
