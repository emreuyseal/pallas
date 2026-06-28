const express = require('express');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// If GROQ_API_KEY is set (e.g. on Render), use Groq. Otherwise use local Ollama.
const GROQ_API_KEY  = process.env.GROQ_API_KEY || '';
const USE_GROQ      = !!GROQ_API_KEY;
const GROQ_BASE     = 'https://api.groq.com/openai/v1';
const OLLAMA_BASE   = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';

const GROQ_MODELS = {
  mini:     'llama-3.1-8b-instant',
  standard: 'llama-3.3-70b-versatile',
  pro:      'llama-3.3-70b-versatile',
};

const OLLAMA_MODELS = {
  mini:     'qwen2.5:3b',
  standard: 'qwen2.5:7b',
  pro:      'qwen2.5:14b',
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// In-memory conversation history keyed by sessionId
const sessions = new Map();
const MAX_HISTORY = 16; // messages (8 turns)

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
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

// Only skip search for pure greetings/small-talk
function isConversational(q) {
  return /^(merhaba|selam|hey|hi|hello|nasıl(sın)?|naber|ne haber|teşekkür|sağ ol|günaydın|iyi günler|iyi akşamlar|görüşürüz|hoşça kal|bye)\b/i.test(q.trim());
}

app.get('/api/chat', async (req, res) => {
  const query   = (req.query.q       || '').toString().trim();
  const modelId = (req.query.model   || 'standard').toString();
  const sid     = (req.query.session || '').toString();
  const lang    = (req.query.lang    || 'tr').toString();
  const model   = OLLAMA_MODELS[modelId] || OLLAMA_MODELS.standard;

  if (!query) return res.status(400).json({ error: 'missing_query' });

  // Session history
  if (sid && !sessions.has(sid)) sessions.set(sid, []);
  const history = sid ? sessions.get(sid) : [];

  // Web search (skip for pure small-talk)
  let results = [];
  if (!isConversational(query)) {
    try { results = await webSearch(query); } catch (_) {}
  }

  // System prompt
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
});
