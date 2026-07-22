const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);
const httpsServer = (() => {
  try {
    const certPath = path.join(__dirname, 'certs', 'cert.pem');
    const keyPath = path.join(__dirname, 'certs', 'key.pem');
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app);
    }
  } catch (error) {
    console.warn('HTTPS certificate not available, continuing with HTTP only.', error.message);
  }
  return null;
})();
const io = new Server(httpServer, { cors: { origin: '*' } });

const dataDir = path.join(__dirname, 'data');
const workspaceFile = path.join(dataDir, 'workspace.json');
fs.mkdirSync(dataDir, { recursive: true });

function createDefaultWorkspace() {
  return {
    id: 'bro-hub',
    name: 'Bro Hub',
    channels: {
      text: [{ id: 'general', name: 'general', messages: [] }],
      voice: [{ id: 'voice', name: 'Voice', users: [] }]
    },
    members: []
  };
}

function saveWorkspace(workspace) {
  fs.writeFileSync(workspaceFile, JSON.stringify(workspace, null, 2));
}

function loadWorkspace() {
  if (!fs.existsSync(workspaceFile)) {
    const initial = createDefaultWorkspace();
    saveWorkspace(initial);
    return initial;
  }

  try {
    return JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  } catch (error) {
    const fallback = createDefaultWorkspace();
    saveWorkspace(fallback);
    return fallback;
  }
}

const workspace = loadWorkspace();

function getTextChannel() {
  return workspace.channels.text[0];
}

function getVoiceChannel() {
  return workspace.channels.voice[0];
}

function addMember(socket, username) {
  const existing = workspace.members.find((member) => member.id === socket.id);
  if (existing) {
    existing.name = username;
    return;
  }

  workspace.members.push({ id: socket.id, name: username });
}

function removeMember(socketId) {
  workspace.members = workspace.members.filter((member) => member.id !== socketId);
  const voiceChannel = getVoiceChannel();
  voiceChannel.users = voiceChannel.users.filter((user) => user.id !== socketId);
}

function broadcastWorkspace() {
  io.emit('workspace:update', { workspace });
}

function broadcastVoiceState() {
  const voiceChannel = getVoiceChannel();
  io.emit('voice:update', { users: voiceChannel.users });
}

function broadcastVoiceFrame(senderSocket, payload) {
  const voiceChannel = getVoiceChannel();
  voiceChannel.users.forEach((user) => {
    if (user.id !== senderSocket.id) {
      senderSocket.to(user.id).emit('voice:frame', { from: senderSocket.id, ...payload });
    }
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Bro app is alive' });
});

app.get('/api/workspace', (req, res) => {
  res.json({ workspace });
});

app.post('/api/messages', (req, res) => {
  const channel = getTextChannel();
  const text = (req.body.text || '').trim();
  if (!text) {
    return res.status(400).json({ ok: false, message: 'Message cannot be empty' });
  }

  channel.messages.push({
    id: Date.now(),
    author: req.body.author || 'Bro',
    text,
    createdAt: new Date().toISOString()
  });

  if (channel.messages.length > 200) {
    channel.messages.shift();
  }

  saveWorkspace(workspace);
  broadcastWorkspace();
  res.status(201).json(channel.messages[channel.messages.length - 1]);
});

io.on('connection', (socket) => {
  socket.data.username = 'Bro';

  socket.on('join-workspace', ({ username }) => {
    socket.data.username = (username || 'Bro').trim() || 'Bro';
    addMember(socket, socket.data.username);
    saveWorkspace(workspace);

    socket.emit('workspace:ready', { workspace, myId: socket.id });
    broadcastWorkspace();
  });

  socket.on('send-message', ({ text }) => {
    const channel = getTextChannel();
    const clean = (text || '').trim();
    if (!clean) return;

    channel.messages.push({
      id: Date.now(),
      author: socket.data.username || 'Bro',
      text: clean,
      createdAt: new Date().toISOString()
    });

    if (channel.messages.length > 200) {
      channel.messages.shift();
    }

    saveWorkspace(workspace);
    broadcastWorkspace();
  });

  socket.on('join-voice', () => {
    const voiceChannel = getVoiceChannel();
    const voiceUser = { id: socket.id, name: socket.data.username || 'Bro' };
    if (!voiceChannel.users.some((user) => user.id === socket.id)) {
      voiceChannel.users.push(voiceUser);
    }

    saveWorkspace(workspace);
    broadcastVoiceState();

    const existingUsers = voiceChannel.users.filter((user) => user.id !== socket.id);
    socket.emit('voice:joined', { user: voiceUser, users: existingUsers });
    socket.broadcast.emit('voice:user-joined', { user: voiceUser });
  });

  socket.on('leave-voice', () => {
    const voiceChannel = getVoiceChannel();
    voiceChannel.users = voiceChannel.users.filter((user) => user.id !== socket.id);
    saveWorkspace(workspace);
    broadcastVoiceState();
    socket.emit('voice:left');
    socket.broadcast.emit('voice:user-left', { id: socket.id });
  });

  socket.on('voice:frame', (payload) => {
    if (!payload?.data) return;
    broadcastVoiceFrame(socket, payload);
  });

  socket.on('disconnect', () => {
    removeMember(socket.id);
    saveWorkspace(workspace);
    broadcastWorkspace();
    broadcastVoiceState();
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5500;
httpServer.listen(PORT, () => {
  console.log(`Bro app listening on http://localhost:${PORT}`);
});

if (httpsServer) {
  const HTTPS_PORT = Number(process.env.HTTPS_PORT || 5443);
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`Bro app listening on https://localhost:${HTTPS_PORT}`);
  });
}

module.exports = { app, httpServer, httpsServer, workspace };
