const express = require('express');
const path    = require('path');
const cheerio = require('cheerio');
const fs      = require('fs');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pallas-dev-secret-change-in-production';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const USE_GROQ     = !!GROQ_API_KEY;
const GROQ_BASE    = 'https://api.groq.com/openai/v1';
const OLLAMA_BASE  = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';

const GROQ_MODELS = {
  mini:     'llama-3.1-8b-instant',
  standard: 'llama-3.3-70b-versatile',
  pro:      'llama-3.3-70b-specdec',
};
const OLLAMA_MODELS = {
  mini:     'llama3.2:3b',
  standard: 'qwen2.5:7b',
  pro:      'qwen2.5:7b',
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Data storage ──────────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHATS_DIR  = path.join(DATA_DIR, 'chats');

fs.mkdirSync(CHATS_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u)); }

function chatsFile(uid) { return path.join(CHATS_DIR, `${uid}.json`); }
function loadUserChats(uid) {
  try { return JSON.parse(fs.readFileSync(chatsFile(uid), 'utf8')); }
  catch (_) { return []; }
}
function saveUserChats(uid, chats) {
  fs.writeFileSync(chatsFile(uid), JSON.stringify(chats));
}

function getPayload(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); }
  catch (_) { return null; }
}

// ── In-memory session history ─────────────────────────────────────────────────
const sessions   = new Map();
const MAX_HISTORY = 16;

// Never cache the HTML file so the browser always gets fresh JS
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Web search ─────────────────────────────────────────────────────────────────
async function webSearch(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=tr-tr`;
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return [];
  const $ = cheerio.load(await res.text());
  const results = [];
  $('.result, .web-result').each((_, el) => {
    if (results.length >= 4) return;
    const titleEl = $(el).find('.result__a, .result__title a').first();
    const title   = titleEl.text().trim();
    const href    = titleEl.attr('href') || '';
    const snippet = $(el).find('.result__snippet').first().text().trim();
    if (!title || !href) return;
    let link = href;
    try {
      const w = new URL(href, 'https://duckduckgo.com');
      const real = w.searchParams.get('uddg');
      if (real) link = decodeURIComponent(real);
    } catch (_) {}
    results.push({ title, link, snippet });
  });
  return results;
}

// ── AI backends ────────────────────────────────────────────────────────────────
async function ollamaChat(model, messages) {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`ollama_http_${res.status}`);
  const data = await res.json();
  return data.message?.content || '';
}

async function groqChat(model, messages) {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model, messages }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`groq_http_${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function aiChat(modelId, messages) {
  if (USE_GROQ) return groqChat(GROQ_MODELS[modelId] || GROQ_MODELS.standard, messages);
  return ollamaChat(OLLAMA_MODELS[modelId] || OLLAMA_MODELS.standard, messages);
}

function isConversational(q) {
  return /^(merhaba|selam|hey|hi|hello|nasıl(sın)?|naber|ne haber|teşekkür|sağ ol|günaydın|iyi günler|iyi akşamlar|görüşürüz|hoşça kal|bye)\b/i.test(q.trim());
}

// ── Auth endpoints ─────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing_fields' });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: 'username_length' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return res.status(400).json({ error: 'username_invalid' });
  if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });

  const users = loadUsers();
  const key   = username.toLowerCase();
  if (users[key]) return res.status(409).json({ error: 'username_taken' });

  const hash   = await bcrypt.hash(password, 10);
  const userId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  users[key]   = { id: userId, username, hash, createdAt: Date.now() };
  saveUsers(users);

  const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing_fields' });

  const users = loadUsers();
  const user  = users[username.toLowerCase()];
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = await bcrypt.compare(password, user.hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

app.get('/api/auth/me', (req, res) => {
  const p = getPayload(req);
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  res.json({ username: p.username });
});

// ── Chat history endpoints ─────────────────────────────────────────────────────
app.get('/api/chats', (req, res) => {
  const p = getPayload(req);
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  const chats = loadUserChats(p.userId);
  res.json(chats.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })));
});

app.get('/api/chats/:id', (req, res) => {
  const p = getPayload(req);
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  const chat = loadUserChats(p.userId).find(c => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: 'not_found' });
  res.json(chat);
});

app.post('/api/chats', (req, res) => {
  const p = getPayload(req);
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  const { id, title, messages, sessionMessages } = req.body || {};
  if (!id) return res.status(400).json({ error: 'missing_id' });
  const chats = loadUserChats(p.userId);
  const idx   = chats.findIndex(c => c.id === id);
  const chat  = { id, title: title || 'Chat', messages: messages || [], sessionMessages: sessionMessages || [], updatedAt: Date.now() };
  if (idx >= 0) chats[idx] = chat;
  else chats.unshift(chat);
  if (chats.length > 100) chats.splice(100);
  saveUserChats(p.userId, chats);
  res.json({ ok: true });
});

app.delete('/api/chats/:id', (req, res) => {
  const p = getPayload(req);
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  const chats = loadUserChats(p.userId).filter(c => c.id !== req.params.id);
  saveUserChats(p.userId, chats);
  res.json({ ok: true });
});

// ── Chat endpoint ──────────────────────────────────────────────────────────────
app.get('/api/chat', async (req, res) => {
  const query   = (req.query.q       || '').toString().trim();
  const modelId = (req.query.model   || 'standard').toString();
  const sid     = (req.query.session || '').toString();
  const lang    = (req.query.lang    || 'tr').toString();

  if (!query) return res.status(400).json({ error: 'missing_query' });

  if (sid && !sessions.has(sid)) sessions.set(sid, []);
  const history = sid ? sessions.get(sid) : [];

  let results = [];
  const doSearch = req.query.search !== 'false';
  if (doSearch && !isConversational(query)) {
    try { results = await webSearch(query); } catch (_) {}
  }

  let system = lang === 'en'
    ? 'You are Pallas, a helpful AI assistant. Always respond in English only. Be natural, concise, and clear. You can use markdown when helpful.'
    : 'Sen Pallas adlı bir yapay zeka asistanısın. Her zaman yalnızca Türkçe yanıt ver. Başka dil kullanma. Doğal, kısa ve net konuş. Gerektiğinde markdown kullanabilirsin.';
  if (results.length > 0) {
    const ctx = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`).join('\n\n');
    system += `\n\nAşağıdaki güncel web arama sonuçlarını yanıtında kullan:\n\n${ctx}`;
  }

  const messages = [
    { role: 'system', content: system },
    ...history.slice(-MAX_HISTORY),
    { role: 'user', content: query },
  ];

  try {
    const text = await aiChat(modelId, messages);
    if (sid) {
      history.push({ role: 'user', content: query });
      history.push({ role: 'assistant', content: text });
      if (history.length > MAX_HISTORY) history.splice(0, 2);
    }
    res.json({ text, results });
  } catch (err) {
    console.error('AI error:', err.message);
    res.status(503).json({ error: 'ollama_unavailable', results });
  }
});

app.post('/api/session/clear', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) sessions.delete(sessionId);
  res.json({ ok: true });
});

app.post('/api/session/restore', (req, res) => {
  const { sessionId, messages } = req.body || {};
  if (sessionId && Array.isArray(messages)) {
    sessions.set(sessionId, messages.slice(-MAX_HISTORY));
  }
  res.json({ ok: true });
});

app.get('/api/status', async (req, res) => {
  if (USE_GROQ) return res.json({ backend: 'groq', ready: true });
  try {
    const r    = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    res.json({ backend: 'ollama', ready: true, models: (data.models || []).map(m => m.name) });
  } catch (_) {
    res.json({ backend: 'ollama', ready: false, models: [] });
  }
});

app.listen(PORT, () => {
  console.log(`Pallas çalışıyor: http://localhost:${PORT}`);
  if (!USE_GROQ) warmupOllama();
});

async function warmupOllama() {
  try {
    await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODELS.standard, prompt: '', stream: false }),
      signal: AbortSignal.timeout(60000),
    });
    console.log('Model sıcak ve hazır.');
  } catch (_) {
    console.log('Ollama warmup atlandı (Ollama çalışmıyor olabilir).');
  }
}
