import { Hono } from 'hono';
import * as cheerio from 'cheerio';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';

const MAX_HISTORY = 16;
const SESSION_TTL_SECONDS = 30 * 60;

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GROQ_MODELS = {
  mini: 'openai/gpt-oss-20b',
  standard: 'openai/gpt-oss-120b',
  pro: 'openai/gpt-oss-120b',
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function stripCJK(text) {
  return text.replace(/[　-鿿가-힯豈-﫿]/g, '').replace(/ {2,}/g, ' ').trim();
}

function isConversational(q) {
  return /^(merhaba|selam|hey|hi|hello|nasıl(sın)?|naber|ne haber|teşekkür|sağ ol|günaydın|iyi günler|iyi akşamlar|görüşürüz|hoşça kal|bye)\b/i.test(q.trim());
}

async function signToken(payload, secret) {
  const key = new TextEncoder().encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key);
}

async function verifyToken(token, secret) {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    return payload;
  } catch (_) {
    return null;
  }
}

function bearerToken(c) {
  const h = c.req.header('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

async function requireAuth(c) {
  const token = bearerToken(c);
  if (!token) return null;
  return verifyToken(token, c.env.JWT_SECRET);
}

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
    const title = titleEl.text().trim();
    const href = titleEl.attr('href') || '';
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

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

async function checkRateLimit(env, ip) {
  const key = `ratelimit:chat:${ip}`;
  const current = await env.SESSIONS.get(key);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= RATE_LIMIT_MAX) return false;
  await env.SESSIONS.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}

async function groqChat(env, model, messages) {
  if (!env.GROQ_API_KEY) throw new Error('groq_api_key_missing');
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({ model, messages }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`groq_http_${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const app = new Hono();

app.post('/api/auth/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, password } = body || {};
  if (!username || !password) return c.json({ error: 'missing_fields' }, 400);
  if (username.length < 2 || username.length > 32) return c.json({ error: 'username_length' }, 400);
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return c.json({ error: 'username_invalid' }, 400);
  if (password.length < 6) return c.json({ error: 'password_too_short' }, 400);

  const key = username.toLowerCase();
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username_lower = ?').bind(key).first();
  if (existing) return c.json({ error: 'username_taken' }, 409);

  const hash = await bcrypt.hash(password, 10);
  const userId = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO users (id, username, username_lower, hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(userId, username, key, hash, Date.now()).run();

  const token = await signToken({ userId, username }, c.env.JWT_SECRET);
  return c.json({ token, username });
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, password } = body || {};
  if (!username || !password) return c.json({ error: 'missing_fields' }, 400);

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username_lower = ?')
    .bind(username.toLowerCase()).first();
  if (!user) return c.json({ error: 'invalid_credentials' }, 401);

  const ok = await bcrypt.compare(password, user.hash);
  if (!ok) return c.json({ error: 'invalid_credentials' }, 401);

  const token = await signToken({ userId: user.id, username: user.username }, c.env.JWT_SECRET);
  return c.json({ token, username: user.username });
});

app.get('/api/auth/me', async (c) => {
  const p = await requireAuth(c);
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ username: p.username });
});

app.get('/api/chats', async (c) => {
  const p = await requireAuth(c);
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, updated_at as updatedAt FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100'
  ).bind(p.userId).all();
  return c.json(results);
});

app.get('/api/chats/:id', async (c) => {
  const p = await requireAuth(c);
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  const row = await c.env.DB.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), p.userId).first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({
    id: row.id,
    title: row.title,
    messages: JSON.parse(row.messages),
    sessionMessages: JSON.parse(row.session_messages),
    updatedAt: row.updated_at,
  });
});

app.post('/api/chats', async (c) => {
  const p = await requireAuth(c);
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const { id, title, messages, sessionMessages } = body || {};
  if (!id) return c.json({ error: 'missing_id' }, 400);

  await c.env.DB.prepare(
    `INSERT INTO chats (id, user_id, title, messages, session_messages, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, user_id) DO UPDATE SET
       title = excluded.title,
       messages = excluded.messages,
       session_messages = excluded.session_messages,
       updated_at = excluded.updated_at`
  ).bind(
    id, p.userId, title || 'Sohbet',
    JSON.stringify(messages || []), JSON.stringify(sessionMessages || []),
    Date.now()
  ).run();

  const { results: over } = await c.env.DB.prepare(
    'SELECT id FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT -1 OFFSET 100'
  ).bind(p.userId).all();
  if (over.length) {
    await c.env.DB.batch(over.map((r) =>
      c.env.DB.prepare('DELETE FROM chats WHERE id = ? AND user_id = ?').bind(r.id, p.userId)
    ));
  }

  return c.json({ ok: true });
});

app.delete('/api/chats/:id', async (c) => {
  const p = await requireAuth(c);
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  await c.env.DB.prepare('DELETE FROM chats WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), p.userId).run();
  return c.json({ ok: true });
});

app.get('/api/chat', async (c) => {
  const query = (c.req.query('q') || '').trim();
  const modelId = c.req.query('model') || 'standard';
  const sid = c.req.query('session') || '';
  const lang = c.req.query('lang') || 'tr';
  const searchParam = c.req.query('search');

  if (!query) return c.json({ error: 'missing_query' }, 400);

  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const allowed = await checkRateLimit(c.env, ip);
  if (!allowed) return c.json({ error: 'rate_limited', results: [] }, 429);

  const sessionKey = sid ? `session:${sid}` : null;
  let history = [];
  if (sessionKey) {
    const stored = await c.env.SESSIONS.get(sessionKey, 'json');
    history = stored || [];
  }

  let results = [];
  const doSearch = searchParam !== 'false';
  if (doSearch && !isConversational(query)) {
    try { results = await webSearch(query); } catch (_) {}
  }

  let system = lang === 'en'
    ? 'You are Pallas, a helpful AI assistant. Respond in English ONLY. Never output Chinese, Japanese, Korean, or any non-Latin characters under any circumstances — not even a single character. If you notice yourself about to write a non-Latin character, stop and write in English instead. Be natural, concise, and clear. You can use markdown when helpful.'
    : 'Sen Pallas adlı bir yapay zeka asistanısın. YALNIZCA Türkçe yanıt ver. Hiçbir durumda Çince, Japonca, Korece veya Latin alfabesi dışı karakter kullanma — tek bir karakter bile olsa. Yanıtında Çince karakter görürsen dur ve Türkçe yaz. Doğal, kısa ve net konuş. Gerektiğinde markdown kullanabilirsin.';
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
    const raw = await groqChat(c.env, GROQ_MODELS[modelId] || GROQ_MODELS.standard, messages);
    const text = stripCJK(raw);
    if (sessionKey) {
      history.push({ role: 'user', content: query });
      history.push({ role: 'assistant', content: text });
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
      await c.env.SESSIONS.put(sessionKey, JSON.stringify(history), { expirationTtl: SESSION_TTL_SECONDS });
    }
    return c.json({ text, results });
  } catch (err) {
    return c.json({ error: 'groq_unavailable', detail: err.message, results }, 503);
  }
});

app.post('/api/session/clear', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { sessionId } = body || {};
  if (sessionId) await c.env.SESSIONS.delete(`session:${sessionId}`);
  return c.json({ ok: true });
});

app.post('/api/session/restore', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { sessionId, messages } = body || {};
  if (sessionId && Array.isArray(messages)) {
    await c.env.SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify(messages.slice(-MAX_HISTORY)),
      { expirationTtl: SESSION_TTL_SECONDS }
    );
  }
  return c.json({ ok: true });
});

app.get('/api/status', (c) => c.json({ backend: 'groq', ready: !!c.env.GROQ_API_KEY }));

app.get('/api/hardware', (c) => c.json({ backend: 'groq', gpu: false, models: [], loaded: [] }));

export default app;
