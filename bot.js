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
const BUSINESS_PHONE      = process.env.BUSINESS_PHONE;
const SESSION_NAME        = process.env.SESSION_NAME || 'mamaz-ai-bot';
const HEADLESS            = process.env.HEADLESS !== 'false';
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY   = process.env.SUPABASE_ANON_KEY;
const PUP_EXEC_PATH       = process.env.PUPPETEER_EXECUTABLE_PATH || undefined; // e.g. /usr/bin/chromium
const PORT                = process.env.PORT || 3000;
const DISABLE_VENOM       = String(process.env.DISABLE_VENOM || 'false').toLowerCase() === 'true';

// Validate required envs (כש־Venom פעיל בלבד)
if (!DISABLE_VENOM) {
  const miss = [];
  if (!BUSINESS_PHONE)    miss.push('BUSINESS_PHONE');
  if (!SUPABASE_URL)      miss.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) miss.push('SUPABASE_ANON_KEY');
  if (miss.length) {
    console.error('❌ Missing env vars:', miss.join(', '));
    // לא מפילים את השרת – משאירים חי כדי לא לקבל 502 בריילווי
  }
}

// ==== Runtime state ====
let botClient = null;
let isReady = false;
let qrBase64 = null;        // שמורים RAW base64 בלבד (ללא prefix)
let connectionStatus = DISABLE_VENOM ? 'disabled' : 'disconnected';
let lastError = null;       // שגיאה אחרונה לסטטוס

// ==== Helpers ====
function toRawBase64(maybeDataUrl) {
  if (!maybeDataUrl) return null;
  const i = maybeDataUrl.indexOf('base64,');
  return i >= 0 ? maybeDataUrl.slice(i + 'base64,'.length) : maybeDataUrl;
}
function toDataUrlPNG(base64) {
  return base64 ? `data:image/png;base64,${base64}` : null;
}

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
    hasQR: !!qrBase64,
    lastError,
    timestamp: new Date().toISOString()
  });
});

// JSON עם שני שדות: base64 ו-dataUrl (לבחירת הלקוח)
app.get('/qr', (_req, res) => {
  if (!qrBase64) return res.status(404).json({ error: 'No QR code available' });
  res.json({ base64: qrBase64, dataUrl: toDataUrlPNG(qrBase64) });
});

// תמונת PNG ישירה
app.get('/qr.png', (_req, res) => {
  if (!qrBase64) return res.status(404).send('No QR code available');
  const buf = Buffer.from(qrBase64, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(buf);
});

// עמוד HTML נח לצפייה (מתעדכן אוטומטית)
app.get('/qr-view', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="he"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp QR</title>
<style>
  body{font-family:system-ui,Arial;margin:24px;direction:rtl}
  #img{width:340px;height:340px;border:1px solid #ddd;object-fit:contain;image-rendering:pixelated}
  #status{margin:8px 0;color:#555}
  pre{background:#f6f8fa;border:1px solid #e5e7eb;padding:12px;border-radius:8px;max-width:620px;overflow:auto}
</style>
</head><body>
  <h1>סריקת QR ל־WhatsApp</h1>
  <div id="status">ממתין ל־QR…</div>
  <img id="img" alt="QR יופיע כאן"/>
  <pre id="meta"></pre>
  <script>
    async function tick(){
      try{
        const st = await fetch('/status',{cache:'no-store'}).then(r=>r.json());
        const lines = [
          'status: ' + st.status,
          'isReady: ' + st.isReady,
          'hasQR: ' + st.hasQR,
          'businessPhone: ' + st.businessPhone,
          st.lastError ? ('lastError: ' + st.lastError) : ''
        ].filter(Boolean).join('\\n');
        document.getElementById('meta').textContent = lines;
      }catch(e){}

      try{
        const r = await fetch('/qr.png?ts=' + Date.now(), {cache:'no-store'});
        if (r.ok) {
          document.getElementById('img').src = '/qr.png?ts=' + Date.now();
          document.getElementById('status').textContent = 'פתח/י WhatsApp > Linked devices > Link a device וסרוק/י את הקוד';
        } else {
          document.getElementById('img').removeAttribute('src');
          document.getElementById('status').textContent = 'אין QR כרגע (מתעדכן כל 3 שניות…)';
        }
      }catch(e){
        document.getElementById('status').textContent = 'שגיאה: ' + e.message;
      }
    }
    tick();
    setInterval(tick, 3000);
  </script>
</body></html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server on :${PORT} | DISABLE_VENOM=${DISABLE_VENOM}`);
});

// ==== Supabase helper (ידלג אם חסרים משתנים) ====
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
      if (!r.ok) throw new Error(\`HTTP \${r.status}: \${r.statusText}\`);
      return await r.json();
    } catch (e) {
      console.error(\`❌ Supabase \${fn} attempt \${i}/\${retries}:\`, e.message);
      lastError = \`Supabase \${fn}: \${e.message}\`;
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
    puppeteerOptions: { executablePath: PUP_EXEC_PATH },
    // בגרסאות האחרונות השם התקני הוא catchQR
    catchQR: (base64, _ascii, attempts) => {
      console.log('📱 QR generated. attempt=', attempts);
      qrBase64 = toRawBase64(base64);
      connectionStatus = 'qr_ready';
    },
    statusCallback: (statusSession) => {
      console.log('📶 Venom status:', statusSession);
      if (statusSession === 'isLogged') {
        connectionStatus = 'connected';
        qrBase64 = null;
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

        // תשובה בסיסית
        await client.sendText(message.from, 'היי! הבוט פעיל 🚀');

        // לוג לדוגמה ל־Supabase (אם הוגדרו ENV)
        await callSupabaseFunction('bot-message', {
          user_id: message.from,
          message: message.body,
          message_type: 'incoming',
          business_phone: BUSINESS_PHONE
        }).catch(() => {});
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
  try { if (botClient) await botClient.close(); } catch {}
  process.exit(0);
}
['SIGINT', 'SIGTERM', 'SIGUSR2'].forEach(s => process.on(s, () => shutdown(s)));
process.on('unhandledRejection', (r) => { console.error('UnhandledRejection:', r); lastError = `unhandledRejection: ${r}`; });
process.on('uncaughtException', (e) => { console.error('UncaughtException:', e); lastError = `uncaughtException: ${e.message}`; });
