const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const certDir = path.join(__dirname, 'certs');
fs.mkdirSync(certDir, { recursive: true });
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '365',
    '-subj', '/CN=localhost'
  ], { stdio: 'inherit' });
}

console.log('cert-ready');
