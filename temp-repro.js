const http = require('http');
const { io } = require('socket.io-client');

http.get('http://localhost:5500/api/health', (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('health', body);
    const socket = io('http://localhost:5500', { transports: ['websocket', 'polling'], forceNew: true });
    socket.on('connect', () => {
      console.log('connected', socket.id);
      socket.emit('join-workspace', { username: 'tester' });
      socket.emit('join-voice');
    });
    socket.on('workspace:ready', (msg) => console.log('workspace ready', msg.workspace.channels.voice[0].users));
    socket.on('voice:joined', (msg) => {
      console.log('voice joined', JSON.stringify(msg));
      socket.disconnect();
      process.exit(0);
    });
    socket.on('voice:update', (msg) => {
      console.log('voice update', JSON.stringify(msg));
    });
    socket.on('connect_error', (err) => {
      console.error('connect_error', err.message);
      process.exit(1);
    });
    setTimeout(() => {
      console.log('timeout waiting for event');
      process.exit(2);
    }, 5000);
  });
}).on('error', (err) => {
  console.error(err);
  process.exit(1);
});
