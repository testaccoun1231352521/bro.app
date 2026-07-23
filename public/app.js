const usernameForm = document.getElementById('usernameForm');
const usernameInput = document.getElementById('usernameInput');
const serverInput = document.getElementById('serverInput');
const serverList = document.getElementById('serverList');
const serverButtons = document.getElementById('serverButtons');
const appView = document.getElementById('appView');
const workspaceName = document.getElementById('workspaceName');
const channelList = document.getElementById('channelList');
const channelTitle = document.getElementById('channelTitle');
const channelContent = document.getElementById('channelContent');
const messageForm = document.getElementById('messageForm') || document.getElementById('chat-form');
const messageInput = document.getElementById('messageInput') || document.getElementById('chat-input');
const voiceUsersList = document.getElementById('voiceUsersList');
const voiceStatus = document.getElementById('voiceStatus');
const voiceJoinButton = document.getElementById('voiceJoinButton') || document.getElementById('join-voice-btn');
const voiceActionButton = document.getElementById('voiceActionButton');
const voiceLeaveButton = document.getElementById('voiceLeaveButton');
const voicePanel = document.getElementById('voicePanel');
const membersList = document.getElementById('membersList');

let socket;
let localStream;
let mediaRecorder;
let audioContext;
let myUsername = '';
let currentServerId = 'bro-hub';
let currentChannelId = 'general';
let voiceJoined = false;
let muted = false;
let pendingVoiceJoin = false;

usernameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim() || 'Bro';
  const serverName = serverInput.value.trim() || 'Bro Hub';
  myUsername = username;
  currentServerId = serverName.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'bro-hub';
  usernameForm.classList.add('hidden');
  appView.classList.remove('hidden');
  connectSocket();
  if (socket?.connected) {
    socket.emit('join-workspace', { username, serverName });
  }
});

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  if (socket?.connected && currentChannelId === 'general') {
    const payload = {
      serverId: currentServerId,
      channelId: currentChannelId,
      text,
      author: myUsername
    };
    socket.emit('send-message', payload);
    socket.emit('sendMessage', payload);
    messageInput.value = '';
  }
});

voiceJoinButton.addEventListener('click', () => {
  joinVoiceChannel();
});

voiceActionButton.addEventListener('click', () => {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !muted;
  });
  voiceActionButton.textContent = muted ? 'Unmute microphone' : 'Mute microphone';
  voiceStatus.textContent = muted ? 'Voice connected (muted)' : 'Voice connected';
});

voiceLeaveButton.addEventListener('click', () => {
  if (!socket?.connected) return;
  leaveVoiceChannel();
});

function connectSocket() {
  if (socket) {
    if (myUsername && socket.connected) {
      socket.emit('join-workspace', { username: myUsername, serverName: currentServerId });
    }
    return;
  }

  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    if (myUsername) {
      socket.emit('join-workspace', { username: myUsername, serverName: currentServerId });
    }

    if (pendingVoiceJoin) {
      pendingVoiceJoin = false;
      joinVoiceChannel();
    }
  });

  socket.on('workspace:ready', ({ workspace, server, currentChannel }) => {
    currentServerId = server.id;
    currentChannelId = currentChannel;
    renderWorkspace(workspace, server);
    showServerList(workspace.servers);
  });

  socket.on('workspace:update', ({ workspace }) => {
    const server = getServerFromWorkspace(workspace, currentServerId);
    renderWorkspace(workspace, server);
    showServerList(workspace.servers);
  });

  socket.on('voice:update', ({ users, serverId }) => {
    if (serverId !== currentServerId) return;
    renderVoiceUsers(users);
  });

  socket.on('voice:joined', ({ users, serverId }) => {
    if (serverId !== currentServerId) return;
    renderVoiceUsers(users);
    if (voiceJoined) {
      voiceStatus.textContent = localStream ? 'Voice connected' : 'Joined voice (mic unavailable)';
      voiceActionButton.classList.remove('hidden');
      voiceLeaveButton.classList.remove('hidden');
      voiceActionButton.textContent = muted ? 'Unmute microphone' : 'Mute microphone';
    }
  });

  socket.on('voice:user-joined', ({ user, serverId }) => {
    if (serverId !== currentServerId || user.id === socket.id) return;
    renderVoiceUsers(getCurrentVoiceUsers().concat(user));
  });

  socket.on('voice:user-left', ({ id, serverId }) => {
    if (serverId !== currentServerId) return;
    renderVoiceUsers(getCurrentVoiceUsers().filter((user) => user.id !== id));
  });

  socket.on('voice:left', ({ serverId }) => {
    if (serverId !== currentServerId) return;
    voiceJoined = false;
    stopVoiceBroadcast();
    updateVoiceControls();
  });

  socket.on('voice:frame', ({ from, data, mimeType, serverId }) => {
    if (serverId !== currentServerId || from === socket.id || !voiceJoined) return;
    playIncomingVoice(data, mimeType);
  });
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    return localStream;
  } catch (error) {
    console.warn('Microphone unavailable, joining voice without audio.', error);
    return null;
  }
}

function startVoiceBroadcast(stream) {
  if (!socket?.connected) return;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return;

  const supportedMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    .find((mime) => window.MediaRecorder && MediaRecorder.isTypeSupported(mime));

  if (!supportedMime) {
    console.warn('MediaRecorder is not supported in this browser.');
    return;
  }

  mediaRecorder = new MediaRecorder(stream, { mimeType: supportedMime });
  mediaRecorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0 || !voiceJoined || !socket?.connected) return;
    const base64 = await blobToBase64(event.data);
    socket.emit('voice:frame', { serverId: currentServerId, data: base64, mimeType: mediaRecorder.mimeType });
  };

  mediaRecorder.start(250);
}

function stopVoiceBroadcast() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      resolve(typeof result === 'string' ? result.split(',')[1] : '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToArrayBuffer(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function playIncomingVoice(base64, mimeType) {
  if (!base64 || typeof window.AudioContext === 'undefined') return;
  if (!audioContext) {
    audioContext = new AudioContext();
  }

  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }

  const buffer = base64ToArrayBuffer(base64);
  audioContext.decodeAudioData(buffer, (audioBuffer) => {
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start();
  }, (error) => {
    console.warn('Unable to decode incoming voice chunk', error, mimeType);
  });
}

function showVoicePanel(show) {
  if (!voicePanel) return;
  voicePanel.classList.toggle('hidden', !show);
}

function updateVoiceControls() {
  if (currentChannelId !== 'voice') {
    showVoicePanel(false);
    voiceJoinButton?.classList?.add('hidden');
    voiceActionButton?.classList?.add('hidden');
    voiceLeaveButton?.classList?.add('hidden');
    return;
  }

  showVoicePanel(true);
  if (voiceJoined) {
    voiceJoinButton.classList.add('hidden');
    voiceActionButton.classList.remove('hidden');
    voiceLeaveButton.classList.remove('hidden');
    voiceStatus.textContent = muted ? 'Voice connected (muted)' : 'Voice connected';
    voiceActionButton.textContent = muted ? 'Unmute microphone' : 'Mute microphone';
  } else {
    voiceJoinButton.classList.remove('hidden');
    voiceActionButton.classList.add('hidden');
    voiceLeaveButton.classList.add('hidden');
    voiceStatus.textContent = 'Voice channel idle';
  }
}

function leaveVoiceChannel() {
  if (!socket?.connected) return;
  socket.emit('leave-voice', { serverId: currentServerId });
  voiceJoined = false;
  stopVoiceBroadcast();
  updateVoiceControls();
}

function joinVoiceChannel() {
  if (!socket?.connected) {
    pendingVoiceJoin = true;
    connectSocket();
    return;
  }

  if (voiceJoined) {
    updateVoiceControls();
    return;
  }

  currentChannelId = 'voice';
  voiceJoined = true;
  updateVoiceControls();
  const payload = { serverId: currentServerId };
  socket.emit('join-voice', payload);
  socket.emit('joinVoice', payload);
  ensureLocalStream().then((stream) => {
    if (stream) {
      startVoiceBroadcast(stream);
      voiceStatus.textContent = muted ? 'Voice connected (muted)' : 'Voice connected';
      voiceActionButton.classList.remove('hidden');
      voiceLeaveButton.classList.remove('hidden');
    } else {
      voiceStatus.textContent = 'Joined voice (mic unavailable)';
    }
  });
}

let currentWorkspace;

function getServerFromWorkspace(workspace, serverId) {
  return workspace.servers?.find((server) => server.id === serverId) || workspace.servers?.[0];
}

function getVoiceChannel(server) {
  return server.voice?.[0] || { id: 'voice', name: 'Voice', users: [] };
}

function renderWorkspace(workspace, server) {
  if (!workspace || !server) return;
  currentWorkspace = workspace;
  workspaceName.textContent = server.name;
  showServerList(workspace.servers);

  const isVoiceChannel = currentChannelId === 'voice';
  const channel = isVoiceChannel ? { id: 'voice', name: 'voice', messages: [] } : getTextChannel(server, currentChannelId);
  channelTitle.textContent = `#${channel.name}`;
  updateChannelSelection();
  updateVoiceControls();

  if (channel.id === 'rules') {
    channelContent.innerHTML = (channel.messages || []).map((message) => `
      <div class="message-card">
        <strong>${message.author}</strong>
        <p>${message.text}</p>
      </div>
    `).join('');
    messageForm.classList.add('hidden');
  } else if (channel.id === 'voice') {
    channelContent.innerHTML = '<p>Click join to enter the voice channel.</p>';
    messageForm.classList.add('hidden');
  } else {
    channelContent.innerHTML = (channel.messages || []).map((message) => `
      <div class="message-card">
        <strong>${message.author}</strong>
        <p>${message.text}</p>
        <small>${new Date(message.createdAt).toLocaleString()}</small>
      </div>
    `).join('');
    messageForm.classList.toggle('hidden', channel.id !== 'general');
  }

  renderVoiceUsers(getVoiceChannel(server).users || []);
  membersList.innerHTML = (server.members || []).map((member) => `<li>${member.name}</li>`).join('');
}

function getTextChannel(server, channelId = 'general') {
  return server.channels.text.find((channel) => channel.id === channelId) || server.channels.text[0];
}

function updateChannelSelection() {
  Array.from(channelList.children).forEach((button) => {
    button.classList.toggle('active', button.dataset.channel === currentChannelId);
  });
}

function showServerList(servers) {
  serverList.classList.remove('hidden');
  serverButtons.innerHTML = servers.map((server) => `
    <button type="button" class="server-button" data-server="${server.id}">${server.name}</button>
  `).join('');
  Array.from(serverButtons.children).forEach((button) => {
    button.addEventListener('click', () => {
      if (!myUsername) {
        serverInput.value = button.textContent;
        serverInput.focus();
        return;
      }
      currentServerId = button.dataset.server;
      currentChannelId = 'general';
      socket.emit('join-workspace', { username: myUsername, serverName: button.textContent });
    });
  });
}

function renderVoiceUsers(users) {
  if (!users?.length) {
    voiceUsersList.innerHTML = '<li>No one in voice yet</li>';
    return;
  }

  voiceUsersList.innerHTML = users.map((user) => `<li data-user-id="${user.id}">${user.name}</li>`).join('');
}

function setupChannelButtons() {
  Array.from(channelList.children).forEach((button) => {
    button.addEventListener('click', () => {
      currentChannelId = button.dataset.channel;
      updateChannelSelection();
      if (!currentWorkspace) return;
      const server = getServerFromWorkspace(currentWorkspace, currentServerId);
      renderWorkspace(currentWorkspace, server);
    });
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  setupChannelButtons();

  try {
    const response = await fetch('/api/workspace');
    const data = await response.json();
    currentWorkspace = data.workspace;
    const server = getServerFromWorkspace(data.workspace, currentServerId);
    showServerList(data.workspace.servers);
    renderWorkspace(data.workspace, server);
  } catch (error) {
    console.error(error);
  }
});
