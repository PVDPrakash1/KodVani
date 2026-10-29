require('dotenv').config();
const express = require('express'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const {
  PORT = 3000, APP_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
  MODEL_API_KEY, META_BASE_URL = 'https://api.meta.ai/v1',
  MODEL_TEXT = 'muse-spark-1.3', MODEL_VOICE = 'muse-voice-transcribe-1.0', MODEL_VIDEO = 'sam-3.1', MODEL_IMAGE = 'muse-image-1.0',
  TRIAL_HOURS = '24', PRICE_INR = '500'
} = process.env;
if (!APP_SECRET) throw new Error('APP_SECRET is required');

const LANGS = ['Java','Python','JavaScript','TypeScript','C','C++','C#','Go','Rust','PHP','Kotlin','Swift','Ruby','SQL','React','Node.js'];
const PROMPTS = {
  learn: l => `Teach me programming language ${l}. Start from the basics and progress step by step with short code examples. Use markdown headings.`,
  interview: l => `Give me the most common ${l} interview questions, grouped by beginner, intermediate and advanced, each with a clear model answer. Use markdown headings.`,
  video: l => `Teach me ${l} with video or visual explanation. Write it as a scene-by-scene visual walkthrough: for each scene describe what appears on screen (diagrams, flows, code animations) and the narration. Use markdown headings.`
};

/* ---- tiny JSON store (swap for MySQL/Mongo in production) ---- */
const DB = path.join(__dirname, 'data.json');
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return { users: {}, orders: {}, cache: {} }; } };
const save = d => fs.writeFileSync(DB, JSON.stringify(d, null, 1));

const hmac = (key, data, enc = 'hex') => crypto.createHmac('sha256', key).update(data).digest(enc);
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const checkPw = (pw, stored) => { const [s, h] = String(stored || '').split(':'); return !!h && safeEq(hashPw(pw, s).split(':')[1], h); };

const status = (d, u) => ({
  name: u.name, email: u.email, created: u.created,
  trialEnds: u.trialEnds || 0, trialActive: (u.trialEnds || 0) > Date.now(),
  subActive: (u.subUntil || 0) > Date.now(), subUntil: u.subUntil || null,
  price: +PRICE_INR,
  payments: Object.entries(d.orders).filter(([, o]) => o.email === u.email && o.paid)
    .map(([id, o]) => ({ id, at: o.paidAt, amount: o.amount })).sort((a, b) => b.at - a.at).slice(0, 10)
});
const hasAccess = s => s.subActive || s.trialActive;

const hits = new Map();
const tooMany = (key, max, win) => (hits.get(key) || []).filter(t => Date.now() - t < win).length >= max;
const hit = key => hits.set(key, [...(hits.get(key) || []), Date.now()].slice(-50));

/* ---- auth: token = base64url({e,x}).signature, valid 30 days ---- */
const makeToken = email => { const p = Buffer.from(JSON.stringify({ e: email, x: Date.now() + 30 * 864e5 })).toString('base64url'); return p + '.' + hmac(APP_SECRET, p, 'base64url'); };
function auth(req, res, next) {
  try {
    const [p, sig] = (req.get('authorization') || '').replace('Bearer ', '').split('.');
    if (!p || !sig || !safeEq(hmac(APP_SECRET, p, 'base64url'), sig)) throw 0;
    const { e, x } = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (x < Date.now() || !load().users[e]) throw 0;
    req.email = e; next();
  } catch { res.status(401).json({ error: 'unauthorized', message: 'Please log in again.' }); }
}

const app = express();
app.set('trust proxy', 1);
const smallJson = express.json({ limit: '100kb', verify: (req, _res, buf) => { req.raw = buf; } });
const bigJson = express.json({ limit: '45mb' });   // voice / image / video uploads (base64)
app.use((req, res, next) => (req.path === '/api/ask-input' ? bigJson : smallJson)(req, res, next));
if (process.env.CORS_ORIGIN) app.use((req, res, next) => {   // only needed if the frontend is hosted on a different address
  res.set({ 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80), email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (tooMany('reg' + req.ip, 20, 3600e3)) return res.status(429).json({ error: 'rate', message: 'Too many sign-ups from this network. Try later.' });
  if (!name) return res.status(400).json({ error: 'bad', message: 'Enter your name.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) return res.status(400).json({ error: 'bad', message: 'Enter a valid email.' });
  if (pw.length < 8 || pw.length > 200) return res.status(400).json({ error: 'bad', message: 'Password must be at least 8 characters.' });
  const d = load();
  const old = d.users[email];
  if (old && old.pw) return res.status(409).json({ error: 'exists', message: 'This email is already registered. Please log in.' });
  const now = Date.now();
  // an account left over from the old email-only version (no password) can be claimed here; its paid time is kept
  d.users[email] = { name, email, pw: hashPw(pw), created: now, trialEnds: now + +TRIAL_HOURS * 3600e3, subUntil: old ? old.subUntil || 0 : 0 };
  save(d); hit('reg' + req.ip);
  res.json({ token: makeToken(email), status: status(d, d.users[email]) });
});

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  const lk = 'log' + req.ip + email;
  if (tooMany(lk, 8, 15 * 60e3)) return res.status(429).json({ error: 'rate', message: 'Too many attempts. Try again in a few minutes.' });
  const d = load(), u = d.users[email];
  if (!u || !checkPw(pw, u.pw)) { hit(lk); return res.status(401).json({ error: 'bad_login', message: 'Incorrect email or password.' }); }
  hits.delete(lk);
  res.json({ token: makeToken(email), status: status(d, u) });
});

app.get('/api/me', auth, (req, res) => { const d = load(); res.json(status(d, d.users[req.email])); });

app.post('/api/account/password', auth, (req, res) => {
  const d = load(), u = d.users[req.email], next = String(req.body.next || '');
  if (!checkPw(String(req.body.current || ''), u.pw)) return res.status(400).json({ error: 'bad', message: 'Current password is incorrect.' });
  if (next.length < 8 || next.length > 200) return res.status(400).json({ error: 'bad', message: 'New password must be at least 8 characters.' });
  u.pw = hashPw(next); save(d); res.json({ ok: true });
});

app.post('/api/ask', auth, async (req, res) => {
  const { lang, tab, fresh } = req.body;
  if (!LANGS.includes(lang) || !PROMPTS[tab]) return res.status(400).json({ error: 'bad_request' });
  const d = load(), s = status(d, d.users[req.email]), key = lang + '|' + tab;
  if (!hasAccess(s)) return res.status(402).json({ error: 'payment_required', message: 'Your free trial has ended. Subscribe to continue.', status: s });

  let text = fresh && s.subActive ? null : d.cache[key];
  if (!text) {
    try {
      text = await spark([{ type: 'input_text', text: PROMPTS[tab](lang) }]);
      const d2 = load(); d2.cache[key] = text; save(d2);
    } catch (e) {
      console.error('llama error', e.message);
      return res.status(502).json({ error: 'model_error', message: 'The model could not answer right now. Please try again.' });
    }
  }
  res.json({ text, status: s });
});

/* ---- Meta Model API helpers (https://dev.meta.ai/docs) ---- */
const metaFetch = (p, opt = {}) => fetch(META_BASE_URL + p, { ...opt, headers: { Authorization: 'Bearer ' + MODEL_API_KEY, ...(opt.headers || {}) } });
const extractText = j => j.output_text || (j.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('') || j.choices?.[0]?.message?.content || '';
const userErr = (message, code = 400) => Object.assign(new Error(message), { user: true, code });
const dataUrlToBlob = u => { const m = /^data:([^;]+);base64,(.*)$/s.exec(u); if (!m) throw userErr('Bad file.'); return new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }); };

// standard answers + image/video understanding: muse-spark-1.3 on the Responses API
async function spark(parts) {
  const r = await metaFetch('/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_TEXT, max_output_tokens: 8000, input: [{ type: 'message', role: 'user', content: parts }] })
  });
  const j = await r.json().catch(() => ({})), text = extractText(j);
  if (!r.ok || !text) throw new Error(`spark ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return text;
}

// voice: muse-voice-transcribe-1.0 (needs mono 16 kHz WAV, up to 10 min; the browser sends that)
async function transcribe(wavB64, lang) {
  const fd = new FormData();
  fd.append('request', new Blob([JSON.stringify({ model: MODEL_VOICE, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', keywords: [lang] })], { type: 'application/json' }));
  fd.append('audio', new Blob([Buffer.from(wavB64, 'base64')], { type: 'audio/wav' }), 'speech.wav');
  const r = await metaFetch('/asr/transcribe', { method: 'POST', headers: { Accept: 'application/json' }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`transcribe ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  if (!String(j.transcript || '').trim()) throw userErr('I couldn’t hear anything in that recording. Please try again.');
  return j.transcript.trim();
}

// image + text: muse-image-1.0 (generate from text, or edit the uploaded image)
async function drawPicture(prompt, imageDataUrl) {
  let r;
  if (imageDataUrl) {
    const fd = new FormData();
    fd.append('model', MODEL_IMAGE); fd.append('prompt', prompt); fd.append('image', dataUrlToBlob(imageDataUrl), 'input.jpg');
    r = await metaFetch('/images/edits', { method: 'POST', body: fd });
  } else {
    r = await metaFetch('/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL_IMAGE, prompt, n: 1 }) });
  }
  const j = await r.json().catch(() => ({})), d = j.data?.[0];
  if (!r.ok || !d) throw new Error(`image ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return d.b64_json ? 'data:image/png;base64,' + d.b64_json : d.url;
}

// video: sam-3.1 returns boxes + masks as text, one line per frame. We keep the boxes.
function parseSam(lines) {
  const frames = new Set(), ids = new Set(), boxes = [];
  for (const line of lines) {
    const fm = line.match(/<(\d+)f>/); if (!fm) continue;
    const f = +fm[1]; frames.add(f);
    const re = /[>,](\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)/g; let m;
    while ((m = re.exec(line))) { ids.add(+m[1]); if (boxes.length < 200) boxes.push({ frame: f, id: +m[1], x1: +m[2], y1: +m[3], x2: +m[4], y2: +m[5], w: +m[6], h: +m[7] }); }
  }
  return { matches: ids.size, frames: frames.size, boxes };
}
async function segment(concept, videoDataUrl) {
  const r = await metaFetch('/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ model: MODEL_VIDEO, stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: concept }, { type: 'input_video', video_url: videoDataUrl }] }] })
  });
  if (!r.ok) throw new Error(`sam ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const lines = [], dec = new TextDecoder(); let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const rows = buf.split('\n'); buf = rows.pop();
    for (const row of rows) {
      if (!row.startsWith('data: ')) continue;
      try { const e = JSON.parse(row.slice(6)); if (e.type === 'response.output_text.delta' && e.delta) lines.push(e.delta); } catch {}
    }
  }
  return parseSam(lines);
}

/* ---- Ask anything: text, voice, image or video about the chosen language ---- */
app.post('/api/ask-input', auth, async (req, res) => {
  const { lang, kind, text = '', audio, image, video, find = '', draw } = req.body || {};
  if (!LANGS.includes(lang) || !['text', 'voice', 'image', 'video'].includes(kind)) return res.status(400).json({ error: 'bad_request', message: 'Choose a language first.' });
  const d = load(), s = status(d, d.users[req.email]);
  if (!hasAccess(s)) return res.status(402).json({ error: 'payment_required', message: 'Your free trial has ended. Subscribe to continue.', status: s });
  if (tooMany('ask' + req.email, 30, 3600e3)) return res.status(429).json({ error: 'rate', message: 'You have reached the hourly limit. Please try again later.' });
  hit('ask' + req.email);
  try {
    let question = String(text).trim().slice(0, 2000);
    const out = { kind, models: {} };
    if (kind === 'text' && !question) throw userErr('Type a question first.');
    if (kind === 'voice') {
      if (typeof audio !== 'string' || audio.length < 100 || audio.length > 8e6) throw userErr('The recording is missing or too long (max about 90 seconds).');
      question = await transcribe(audio, lang); out.transcript = question; out.models.voice = MODEL_VOICE;
    }
    const parts = [{ type: 'input_text', text:
      `You are a friendly ${lang} tutor and interview coach. Help with the learner’s request about ${lang}. Be clear and concise, use short markdown code examples, and reply in the language the learner used (code stays in English). If the request is not about ${lang} or programming, politely steer back to ${lang}.\n\nLearner: ` +
      (question || `Explain what this ${kind} shows and how it relates to ${lang}.`) }];
    if (kind === 'image') { if (!/^data:image\//.test(image || '') || image.length > 11e6) throw userErr('Please attach a smaller image.'); parts.push({ type: 'input_image', image_url: image }); }
    if (kind === 'video') { if (!/^data:video\//.test(video || '') || video.length > 30e6) throw userErr('Please attach an MP4 under 20 MB.'); parts.push({ type: 'input_video', video_url: video }); }
    out.answer = await spark(parts); out.models.text = MODEL_TEXT;

    if (kind === 'video' && String(find).trim()) {
      try { out.segments = await segment(String(find).trim().slice(0, 60), video); out.models.video = MODEL_VIDEO; }
      catch (e) { console.error(e.message); out.segmentsError = 'Object highlighting is unavailable right now.'; }
    }
    if (draw && kind !== 'video') {
      try {
        const topic = question || 'this image';
        out.picture = await drawPicture(kind === 'image'
          ? `Redraw this as a clean, labeled educational diagram that explains: ${topic} (topic: ${lang}).`
          : `A clean, labeled educational diagram on a white background that explains: ${topic} (topic: ${lang}). Readable text labels.`, kind === 'image' ? image : null);
        out.models.image = MODEL_IMAGE;
      } catch (e) { console.error(e.message); out.pictureError = 'The picture could not be created this time.'; }
    }
    out.status = s;
    res.json(out);
  } catch (e) {
    console.error('ask-input', e.message);
    if (e.user) return res.status(e.code).json({ error: 'bad_request', message: e.message });
    res.status(502).json({ error: 'model_error', message: 'The model could not answer right now. Please try again.' });
  }
});

/* ---- Razorpay ---- */
const rz = (p, body) => fetch('https://api.razorpay.com/v1' + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(RAZORPAY_KEY_ID + ':' + RAZORPAY_KEY_SECRET).toString('base64') },
  body: JSON.stringify(body)
}).then(r => r.json());

function activate(d, orderId) {
  const o = d.orders[orderId];
  if (!o || o.paid) return;
  o.paid = true; o.paidAt = Date.now();
  const u = d.users[o.email];
  u.subUntil = Math.max(Date.now(), u.subUntil || 0) + 365 * 864e5;   // renewals stack
}

app.post('/api/pay/order', auth, async (req, res) => {
  const o = await rz('/orders', { amount: +PRICE_INR * 100, currency: 'INR', receipt: 'dp_' + Date.now(), notes: { email: req.email } });
  if (!o.id) { console.error(o); return res.status(502).json({ error: 'order_failed', message: 'Could not start payment.' }); }
  const d = load(); d.orders[o.id] = { email: req.email, paid: false, amount: +PRICE_INR, at: Date.now() }; save(d);
  res.json({ orderId: o.id, amount: o.amount, key: RAZORPAY_KEY_ID });
});

app.post('/api/pay/verify', auth, (req, res) => {
  const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = req.body;
  const d = load(), o = d.orders[oid];
  if (!o || o.email !== req.email || !safeEq(hmac(RAZORPAY_KEY_SECRET, oid + '|' + pid), sig)) return res.status(400).json({ error: 'bad_signature', message: 'Payment could not be verified.' });
  activate(d, oid); save(d);
  res.json(status(d, d.users[req.email]));
});

// Backup if the browser closes before verify runs. Dashboard > Webhooks: payment.captured / order.paid
app.post('/api/pay/webhook', (req, res) => {
  if (!safeEq(hmac(RAZORPAY_WEBHOOK_SECRET, req.raw), req.get('x-razorpay-signature') || '')) return res.status(400).end();
  const ev = req.body, oid = ev.payload?.payment?.entity?.order_id || ev.payload?.order?.entity?.id;
  if (['payment.captured', 'order.paid'].includes(ev.event) && oid) { const d = load(); activate(d, oid); save(d); }
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('KodVani on http://localhost:' + PORT));
