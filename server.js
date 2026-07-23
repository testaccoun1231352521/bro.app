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
    servers: [
      {
        id: 'bro-hub',
        name: 'Bro Hub',
        channels: {
          text: [
            { id: 'general', name: 'general', messages: [] },
            {
              id: 'rules',
              name: 'rules',
              messages: [
                { id: Date.now() + 1, author: 'System', text: '1. Keep it respectful.', createdAt: new Date().toISOString() },
                { id: Date.now() + 2, author: 'System', text: '2. No harassment or hate.', createdAt: new Date().toISOString() },
                { id: Date.now() + 3, author: 'System', text: '3. Do not share other people’s personal information.', createdAt: new Date().toISOString() },
                { id: Date.now() + 4, author: 'System', text: '4. Keep the chat bro-friendly.', createdAt: new Date().toISOString() }
              ]
            }
          ]
        },
        voice: [{ id: 'voice', name: 'Voice', users: [] }],
        members: []
      }
    ]
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

const workspace = loadWorkspace() || { servers: [] };
if (!workspace.servers) {
    workspace.servers = [];
}

function normalizeServerId(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function getServer(serverId) {
  function getServer(serverId) {
    return workspace?.servers?.find((server) => server.id === normalizeServerId(serverId));
}
}

function createServer(name) {
  const id = normalizeServerId(name || `server-${Date.now()}`);
  const server = {
    id,
    name: name.trim() || `Server ${id}`,
    channels: {
      text: [
        { id: 'general', name: 'general', messages: [] },
        {
          id: 'rules',
          name: 'rules',
          messages: [
            { id: Date.now() + 1, author: 'System', text: '1. Keep it respectful.', createdAt: new Date().toISOString() },
            { id: Date.now() + 2, author: 'System', text: '2. No harassment or hate.', createdAt: new Date().toISOString() },
            { id: Date.now() + 3, author: 'System', text: '3. Do not share other people’s personal information.', createdAt: new Date().toISOString() },
            { id: Date.now() + 4, author: 'System', text: '4. Keep the chat bro-friendly.', createdAt: new Date().toISOString() }
          ]
        }
      ]
    },
    voice: [{ id: 'voice', name: 'Voice', users: [] }],
    members: []
  };

  workspace.servers.push(server);
  saveWorkspace(workspace);
  return server;
}

function getTextChannel(server, channelId = 'general') {
  return server.channels.text.find((channel) => channel.id === channelId) || server.channels.text[0];
}

function getVoiceChannel(server) {
  return server.voice[0];
}

function addMemberToServer(server, socket, username) {
  const existing = server.members.find((member) => member.id === socket.id);
  if (existing) {
    existing.name = username;
    return;
  }

  server.members.push({ id: socket.id, name: username });
}

function removeMemberFromServer(server, socketId) {
  if (!server) return;
  server.members = server.members.filter((member) => member.id !== socketId);
  const voiceChannel = getVoiceChannel(server);
  voiceChannel.users = voiceChannel.users.filter((user) => user.id !== socketId);
}

function broadcastWorkspace() {
  io.emit('workspace:update', { workspace });
}

function broadcastVoiceState(server) {
  const voiceChannel = getVoiceChannel(server);
  io.emit('voice:update', { serverId: server.id, users: voiceChannel.users });
}

function broadcastVoiceFrame(senderSocket, payload) {
  const server = getServer(payload.serverId);
  if (!server) return;
  const voiceChannel = getVoiceChannel(server);
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
  const serverId = req.body.serverId;
  const channelId = req.body.channelId || 'general';
  const server = getServer(serverId);
  if (!server) {
    return res.status(404).json({ ok: false, message: 'Server not found' });
  }

  const channel = getTextChannel(server, channelId);
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

  socket.on('join-workspace', ({ username, serverName }) => {
    socket.data.username = (username || 'Bro').trim() || 'Bro';
    const serverId = normalizeServerId(serverName || 'bro-hub');
    let server = getServer(serverId);
    if (!server) {
      server = createServer(serverName || 'Bro Hub');
    }

    socket.data.serverId = server.id;
    addMemberToServer(server, socket, socket.data.username);
    saveWorkspace(workspace);

    socket.emit('workspace:ready', { workspace, myId: socket.id, server, currentChannel: 'general' });
    broadcastWorkspace();
  });

  socket.on('send-message', ({ serverId, channelId, text }) => {
    const server = getServer(serverId);
    if (!server) return;

    const channel = getTextChannel(server, channelId);
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

  socket.on('sendMessage', ({ serverId, channelId, text }) => {
    const server = getServer(serverId);
    if (!server) return;

    const channel = getTextChannel(server, channelId);
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

  socket.on('join-voice', ({ serverId }) => {
    const server = getServer(serverId);
    if (!server) return;

    const voiceChannel = getVoiceChannel(server);
    const voiceUser = { id: socket.id, name: socket.data.username || 'Bro' };
    if (!voiceChannel.users.some((user) => user.id === socket.id)) {
      voiceChannel.users.push(voiceUser);
    }

    saveWorkspace(workspace);
    broadcastVoiceState(server);

    socket.emit('voice:joined', { users: voiceChannel.users, serverId });
    socket.broadcast.emit('voice:user-joined', { user: voiceUser, serverId });
  });

  socket.on('joinVoice', ({ serverId }) => {
    const server = getServer(serverId);
    if (!server) return;

    const voiceChannel = getVoiceChannel(server);
    const voiceUser = { id: socket.id, name: socket.data.username || 'Bro' };
    if (!voiceChannel.users.some((user) => user.id === socket.id)) {
      voiceChannel.users.push(voiceUser);
    }

    saveWorkspace(workspace);
    broadcastVoiceState(server);

    socket.emit('voice:joined', { users: voiceChannel.users, serverId });
    socket.broadcast.emit('voice:user-joined', { user: voiceUser, serverId });
  });

  socket.on('leave-voice', ({ serverId }) => {
    const server = getServer(serverId);
    if (!server) return;

    const voiceChannel = getVoiceChannel(server);
    voiceChannel.users = voiceChannel.users.filter((user) => user.id !== socket.id);
    saveWorkspace(workspace);
    broadcastVoiceState(server);
    socket.emit('voice:left', { serverId });
    socket.broadcast.emit('voice:user-left', { id: socket.id, serverId });
  });

  socket.on('voice:frame', ({ serverId, data, mimeType }) => {
    if (!data) return;
    const server = getServer(serverId);
    if (!server) return;
    broadcastVoiceFrame(socket, { serverId, data, mimeType });
  });

  socket.on('disconnect', () => {
    const serverId = socket.data.serverId;
    const server = getServer(serverId);
    if (server) {
      removeMemberFromServer(server, socket.id);
      saveWorkspace(workspace);
      broadcastWorkspace();
      broadcastVoiceState(server);
    }
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
  //const HTTPS_PORT = Number(process.env.HTTPS_PORT || 5443);
  //httpsServer.listen(HTTPS_PORT, () => {
    //console.log(`Bro app listening on https://localhost:${HTTPS_PORT}`);
  //});
}

module.exports = { app, httpServer, httpsServer, workspace };
