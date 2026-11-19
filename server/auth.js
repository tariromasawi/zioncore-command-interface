const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TOKENS_FILE = path.join(__dirname, '..', 'data', 'sessions.json');
const DEMO_USERS = {
  commander: {
    passwordHash: hash('masawi-throne-77'),
    role: 'commander',
    displayName: 'His Royal Highness, Saint Tariro Masawi'
  },
  heir: {
    passwordHash: hash('masawi-throne-77'),
    role: 'heir',
    displayName: 'HRH Tarry Kupakwashe Masawi'
  }
};
function hash(s) {
  return crypto.createHash('sha256').update(s + '|zioncore-demo-salt').digest('hex');
}
function loadSessions() {
  try {
    if (fs.existsSync(TOKENS_FILE)) return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {}
  return {};
}
function saveSessions(sessions) {
  const dir = path.dirname(TOKENS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(sessions, null, 2));
}
function createSession(username) {
  const user = DEMO_USERS[username];
  if (!user) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const sessions = loadSessions();
  sessions[token] = {
    username,
    role: user.role,
    displayName: user.displayName,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
  };
  saveSessions(sessions);
  return { token, ...sessions[token] };
}
function validateToken(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s) return null;
  if (new Date(s.expiresAt) < new Date()) {
    delete sessions[token];
    saveSessions(sessions);
    return null;
  }
  return s;
}
function destroySession(token) {
  const sessions = loadSessions();
  delete sessions[token];
  saveSessions(sessions);
}
function authenticate(username, password) {
  const user = DEMO_USERS[username];
  if (!user || user.passwordHash !== hash(password)) return null;
  return createSession(username);
}
function getTokenFromRequest(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers['cookie'] || '';
  const match = cookie.match(/(?:^|;\s*)zioncore_token=([^;]+)/);
  if (match) return match[1];
  return null;
}
module.exports = { authenticate, validateToken, destroySession, getTokenFromRequest, DEMO_USERS };
