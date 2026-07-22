const usernameForm = document.getElementById('usernameForm');
const usernameInput = document.getElementById('usernameInput');
const appView = document.getElementById('appView');
const workspaceName = document.getElementById('workspaceName');
const textChannelName = document.getElementById('textChannelName');
const messagesList = document.getElementById('messagesList');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const voiceUsersList = document.getElementById('voiceUsersList');
const voiceStatus = document.getElementById('voiceStatus');
const voiceButton = document.getElementById('voiceButton');
const membersList = document.getElementById('membersList');

let socket;
let localStream;
let mediaRecorder;
let audioContext;
let myUsername = '';
let voiceJoined = false;
let pendingVoiceJoin = false;

usernameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim() || 'Bro';
  myUsername = username;
  usernameForm.classList.add('hidden');
  appView.classList.remove('hidden');
  connectSocket();
  if (socket?.connected) {
    socket.emit('join-workspace', { username });
  }
});

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  if (socket?.connected) {
    socket.emit('send-message', { text });
    messageInput.value = '';
  }
});

voiceButton.addEventListener('click', async () => {
  if (!socket) {
    connectSocket();
  }

  if (voiceJoined) {
    socket?.emit('leave-voice');
    voiceJoined = false;
    voiceButton.textContent = 'Join voice';
    voiceStatus.textContent = 'Voice channel idle';
    stopVoiceBroadcast();
    return;
  }

  if (!socket?.connected) {
    pendingVoiceJoin = true;
    voiceButton.textContent = 'Joining...';
    voiceStatus.textContent = 'Connecting to voice...';
    return;
  }

  voiceJoined = true;
  voiceButton.textContent = 'Leave voice';
  voiceStatus.textContent = 'Joining voice...';
  socket.emit('join-voice');

  const stream = await ensureLocalStream();
  if (stream) {
    startVoiceBroadcast(stream);
    voiceStatus.textContent = 'Voice connected';
  } else {
    voiceStatus.textContent = 'Joined voice (mic unavailable)';
  }
});

function connectSocket() {
  if (socket) {
    if (myUsername && socket.connected) {
      socket.emit('join-workspace', { username: myUsername });
    }
    return;
  }

  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    if (myUsername) {
      socket.emit('join-workspace', { username: myUsername });
    }

    if (pendingVoiceJoin) {
      pendingVoiceJoin = false;
      voiceButton.click();
    }
  });

  socket.on('workspace:ready', ({ workspace }) => {
    renderWorkspace(workspace);
  });

  socket.on('workspace:update', ({ workspace }) => {
    renderWorkspace(workspace);
  });

  socket.on('voice:update', ({ users }) => {
    renderVoiceUsers(users);
  });

  socket.on('voice:joined', ({ users }) => {
    renderVoiceUsers(users);
    if (voiceJoined) {
      voiceStatus.textContent = localStream ? 'Voice connected' : 'Joined voice (mic unavailable)';
    }
  });

  socket.on('voice:user-joined', ({ user }) => {
    if (user.id === socket.id) return;
    renderVoiceUsers(getCurrentVoiceUsers().concat(user));
  });

  socket.on('voice:user-left', ({ id }) => {
    renderVoiceUsers(getCurrentVoiceUsers().filter((user) => user.id !== id));
  });

  socket.on('voice:left', () => {
    voiceJoined = false;
    voiceButton.textContent = 'Join voice';
    voiceStatus.textContent = 'Voice channel idle';
    stopVoiceBroadcast();
  });

  socket.on('voice:frame', ({ from, data, mimeType }) => {
    if (from === socket.id || !voiceJoined) return;
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
    socket.emit('voice:frame', { data: base64, mimeType: mediaRecorder.mimeType });
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

function getCurrentVoiceUsers() {
  return Array.from(voiceUsersList.querySelectorAll('li')).map((item) => ({
    id: item.dataset.userId || '',
    name: item.textContent
  })).filter((user) => user.id);
}

function renderWorkspace(workspace) {
  if (!workspace) return;
  workspaceName.textContent = workspace.name;
  const textChannel = workspace.channels?.text?.[0];
  const voiceChannel = workspace.channels?.voice?.[0];
  if (textChannel) {
    textChannelName.textContent = `#${textChannel.name}`;
    messagesList.innerHTML = (textChannel.messages || []).map((message) => `
      <div class="message-card">
        <strong>${message.author}</strong>
        <p>${message.text}</p>
        <small>${new Date(message.createdAt).toLocaleString()}</small>
      </div>
    `).join('');
  }
  if (voiceChannel) {
    renderVoiceUsers(voiceChannel.users || []);
  }
  membersList.innerHTML = (workspace.members || []).map((member) => `<li>${member.name}</li>`).join('');
}

function renderVoiceUsers(users) {
  if (!users?.length) {
    voiceUsersList.innerHTML = '<li>No one in voice yet</li>';
    return;
  }

  voiceUsersList.innerHTML = users.map((user) => `<li data-user-id="${user.id}">${user.name}</li>`).join('');
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('/api/workspace');
    const data = await response.json();
    renderWorkspace(data.workspace);
  } catch (error) {
    console.error(error);
  }
});
