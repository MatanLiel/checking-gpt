// --- Polyfills for Node fetch + File via undici ---
const { fetch, File, Headers, Request, Response } = require('undici');
globalThis.fetch = globalThis.fetch || fetch;
globalThis.File = globalThis.File || File;
globalThis.Headers = globalThis.Headers || Headers;
globalThis.Request = globalThis.Request || Request;
globalThis.Response = globalThis.Response || Response;

const express = require('express');
const cors = require('cors');
const venom = require('venom-bot');

// ==== Config ====
const BUSINESS_PHONE = process.env.BUSINESS_PHONE;
const SESSION_NAME = process.env.SESSION_NAME || 'mamaz-ai-bot';
const HEADLESS = process.env.HEADLESS !== 'false';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PORT = process.env.PORT || 3000;
const DISABLE_VENOM = String(process.env.DISABLE_VENOM || 'false').toLowerCase() === 'true';

// Validate required envs (when venom is enabled)
if (!DISABLE_VENOM) {
  const miss = [];
  if (!BUSINESS_PHONE) miss.push('BUSINESS_PHONE');
  if (!SUPABASE_URL) miss.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) miss.push('SUPABASE_ANON_KEY');
  if (miss.length) {
    console.error('❌ Missing env vars:', miss.join(', '));
    // לא מפילים את השרת – משאירים אותו חי לצורכי בדיקות בריילווי
  }
}

// ==== Runtime state ====
let botClient = null;
let isReady = false;
let qrCodeData = null;
let connectionStatus = DISABLE_VENOM ? 'disabled' : 'disconnected';

// ==== Express ====
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ ok: true, message: 'Bot is alive' }));
app.get('/health', (req, res) => {
  res.json({
    ok: isReady || DISABLE_VENOM,
    status: isReady ? 'ready' : DISABLE_VENOM ? 'disabled' : 'not_ready',
    business_phone: BUSINESS_PHONE || null,
    timestamp: new Date().toISOString()
  });
});
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    isReady,
    businessPhone: BUSINESS_PHONE || null,
    hasQR: !!qrCodeData,
    timestamp: new Date().toISOString()
  });
});
app.get('/qr', (req, res) => {
  if (qrCodeData) return res.json({ qr: qrCodeData });
  res.status(404).json({ error: 'No QR code available' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server on :${PORT} | DISABLE_VENOM=${DISABLE_VENOM}`);
});

// ==== Supabase helper (optional; safe if vars missing) ====
async function callSupabaseFunction(fn, data, retries = 3) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return { ok: true, skipped: true };
  const url = `${SUPABASE_URL}/functions/v1/${fn}`;
  for (let i = 1; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify(data)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      return await r.json();
    } catch (e) {
      console.error(`❌ Supabase ${fn} attempt ${i}/${retries}:`, e.message);
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 2 ** i * 1000));
    }
  }
}

// ==== Venom (guarded by DISABLE_VENOM) ====
if (!DISABLE_VENOM) {
  console.log('🚀 Starting Venom…');
  venom.create({
    session: SESSION_NAME,
    headless: HEADLESS,
    useChrome: false,
    browserArgs: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],
    puppeteerOptions: { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined },
    qrCallback: (base64Qr, _ascii, attempts) => {
      console.log('📱 QR generated. attempt=', attempts);
      qrCodeData = base64Qr;
      connectionStatus = 'qr_ready';
    },
    statusCallback: (statusSession) => {
      console.log('📶 Venom status:', statusSession);
      if (statusSession === 'isLogged') { connectionStatus = 'connected'; qrCodeData = null; isReady = true; }
      else if (statusSession === 'notLogged') { connectionStatus = 'disconnected'; isReady = false; }
      else if (statusSession === 'qrReadSuccess') { connectionStatus = 'connecting'; }
      else if (statusSession === 'browserClose') { connectionStatus = 'disconnected'; isReady = false; }
    }
  })
  .then((client) => {
    botClient = client;
    console.log('✅ Venom ready. Waiting for messages…');
    client.onMessage(async (message) => {
      try {
        if (message.isGroupMsg || message.from === 'status@broadcast' || message.fromMe) return;
        // פה תוכל לקרוא ל-Supabase ו/או ל-LLM
        await client.sendText(message.from, 'היי! הבוט פעיל 🚀');
      } catch (e) {
        console.error('❌ onMessage error:', e);
      }
    });
  })
  .catch((e) => {
    // לא מפילים את התהליך כדי למנוע 502
    console.error('❌ Venom failed to start:', e);
    connectionStatus = 'error';
  });
} else {
  console.log('🧪 Safe mode: Venom is disabled. Only HTTP endpoints are up.');
}

// graceful shutdown
async function shutdown(signal) {
  console.log(`\n🔄 ${signal} received`);
  try {
    if (botClient) await botClient.close();
  } catch {}
  process.exit(0);
}
['SIGINT', 'SIGTERM', 'SIGUSR2'].forEach(s => process.on(s, () => shutdown(s)));
process.on('unhandledRejection', (r) => console.error('UnhandledRejection:', r));
process.on('uncaughtException', (e) => console.error('UncaughtException:', e));
