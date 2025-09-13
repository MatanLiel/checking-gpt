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
const SESSION_NAME   = process.env.SESSION_NAME || 'mamaz-ai-bot';
const HEADLESS       = process.env.HEADLESS !== 'false';
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PORT           = process.env.PORT || 3000;
const DISABLE_VENOM  = String(process.env.DISABLE_VENOM || 'false').toLowerCase() === 'true';

// Validate required envs (כש־Venom פעיל בלבד)
if (!DISABLE_VENOM) {
  const miss = [];
  if (!BUSINESS_PHONE)     miss.push('BUSINESS_PHONE');
  if (!SUPABASE_URL)       miss.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY)  miss.push('SUPABASE_ANON_KEY');
  if (miss.length) {
    console.error('❌ Missing env vars:', miss.join(', '));
    // לא מפילים את השרת – נשאירו חי כדי ש־Railway לא יחזיר 502 בזמן בדיקות
  }
}

// ==== Runtime state ====
let botClient = null;
let isReady = false;
let qrCodeData = null;
let connectionStatus = DISABLE_VENOM ? 'disabled' : 'disconnected';
let lastError = null; // לשמירת הודעת שגיאה אחרונה לסטטוס

// ==== Express ====
const app = express();
app.use(cors());
app.use(express.json());

// Root & Health
app.get('/', (_req, res) => res.json({ ok: true, message: 'Bot is alive' }));
app.get('/health', (_req, res) => {
  res.json({
    ok: isReady || DISABLE_VENOM,
    status: isReady ? 'ready' : DISABLE_VENOM ? 'disabled' : 'not_ready',
    business_phone: BUSINESS_PHONE || null,
    timestamp: new Date().toISOString()
  });
});

// סטטוס מלא
app.get('/status', (_req, res) => {
  res.json({
    status: connectionStatus,
    isReady,
    businessPhone: BUSINESS_PHONE || null,
    hasQR: !!qrCodeData,
    lastError, // נראה למה נפל אם יש
    timestamp: new Date().toISOString()
  });
});

// API גולמי להחזרת ה־QR (base64)
app.get('/qr', (_req, res) => {
  if (qrCodeData) return res.json({ qr: qrCodeData });
  res.status(404).json({ error: 'No QR code available' });
});

// דף HTML להצגת ה־QR כתמונה שמתעדכנת אוטומטית
app.get('/qr-page', (_req, res) => {
  res.send(`<!doctype html>
<html lang="he"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp QR</title>
<style>
  body{font-family:system-ui,Arial;margin:24px;direction:rtl}
  #img{width:320px;height:320px;border:1px solid #ddd;object-fit:contain}
  #status{margin:8px 0;color:#555}
  .row{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}
  pre{background:#f6f8fa;border:1px solid #e5e7eb;padding:12px;border-radius:8px;max-width:560px;overflow:auto}
</style>
</head><body>
  <h1>סריקת QR ל־WhatsApp</h1>
  <div id="status">ממתין ל־QR…</div>
  <div class="row">
    <img id="img" alt="QR יופיע כאן"/>
    <pre id="meta"></pre>
  </div>
  <script>
    async function refresh(){
      // מצב הבוט
      try{
        const s = await fetch('/status',{cache:'no-store'}).then(r=>r.json());
        const m = [
          'status: ' + s.status,
          'isReady: ' + s.isReady,
          'hasQR: ' + s.hasQR,
          'businessPhone: ' + s.businessPhone,
          s.lastError ? ('lastError: ' + s.lastError) : ''
        ].filter(Boolean).join('\\n');
        document.getElementById('meta').textContent = m;
      }catch(e){ /* ignore */ }

      // QR
      try{
        const r = await fetch('/qr',{cache:'no-store'});
        if(!r.ok){
          document.getElementById('status').textContent = 'אין QR כרגע (מתעדכן כל 3 שניות…)';
          document.getElementById('img').src = '';
        }else{
          const j = await r.json();
          document.getElementById('img').src = 'data:image/png;base64,'+j.qr;
          document.getElementById('status').textContent = 'פתח/י WhatsApp > Linked devices > Link a device וסרוק/י את הקוד';
        }
      }catch(e){
        document.getElementById('status').textContent = 'שגיאה בטעינת QR: ' + e.message;
      }
    }
    refresh();
    setInterval(refresh, 3000);
  </script>
</body></html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server on :${PORT} | DISABLE_VENOM=${DISABLE_VENOM}`);
});

// ==== Supabase helper (בטוח – ידלג אם חסרים משתנים) ====
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
      lastError = `Supabase ${fn}: ${e.message}`;
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
    catchQR: (base64Qr, _ascii, attempts) => {
      console.log('📱 QR generated. attempt=', attempts);
      qrCodeData = base64Qr;
      connectionStatus = 'qr_ready';
    },
    statusCallback: (statusSession) => {
      console.log('📶 Venom status:', statusSession);
      if (statusSession === 'isLogged') {
        connectionStatus = 'connected';
        qrCodeData = null;
        isReady = true;
      } else if (statusSession === 'notLogged') {
        connectionStatus = 'disconnected';
        isReady = false;
      } else if (statusSession === 'qrReadSuccess') {
        connectionStatus = 'connecting';
      } else if (statusSession === 'browserClose') {
        connectionStatus = 'disconnected';
        isReady = false;
      }
    }
  })
  .then((client) => {
    botClient = client;
    console.log('✅ Venom ready. Waiting for messages…');

    client.onMessage(async (message) => {
      try {
        if (message.isGroupMsg || message.from === 'status@broadcast' || message.fromMe) return;

        // דוגמה: תשובה בסיסית
        await client.sendText(message.from, 'היי! הבוט פעיל 🚀');

        // לדוגמה לוג ל־Supabase (אם מוגדרים משתנים)
        await callSupabaseFunction('bot-message', {
          user_id: message.from,
          message: message.body,
          message_type: 'incoming',
          business_phone: BUSINESS_PHONE
        }).catch(() => { /* swallow */ });

      } catch (e) {
        console.error('❌ onMessage error:', e);
        lastError = `onMessage: ${e.message}`;
      }
    });
  })
  .catch((e) => {
    // לא מפילים את התהליך כדי למנוע 502
    console.error('❌ Venom failed to start:', e);
    lastError = `startup: ${e.message}`;
    connectionStatus = 'error';
  });
} else {
  console.log('🧪 Safe mode: Venom is disabled. Only HTTP endpoints are up.');
}

// ==== graceful shutdown ====
async function shutdown(signal) {
  console.log(`\n🔄 ${signal} received`);
  try {
    if (botClient) await botClient.close();
  } catch {}
  process.exit(0);
}
['SIGINT', 'SIGTERM', 'SIGUSR2'].forEach(s => process.on(s, () => shutdown(s)));
process.on('unhandledRejection', (r) => { console.error('UnhandledRejection:', r); lastError = `unhandledRejection: ${r}`; });
process.on('uncaughtException', (e) => { console.error('UncaughtException:', e); lastError = `uncaughtException: ${e.message}`; });
