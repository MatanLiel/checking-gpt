// --- Polyfills for Node fetch + File via undici (safe for Node 18) ---
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
const BUSINESS_PHONE    = process.env.BUSINESS_PHONE;
const SESSION_NAME      = process.env.SESSION_NAME || 'mamaz-ai-bot';
const HEADLESS          = process.env.HEADLESS !== 'false';
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PUP_EXEC_PATH     = process.env.PUPPETEER_EXECUTABLE_PATH || undefined; // e.g. /usr/bin/chromium
const PORT              = process.env.PORT || 3000;
const DISABLE_VENOM     = String(process.env.DISABLE_VENOM || 'false').toLowerCase() === 'true';

// Validate required envs only when Venom is enabled
if (!DISABLE_VENOM) {
  const miss = [];
  if (!BUSINESS_PHONE)    miss.push('BUSINESS_PHONE');
  if (!SUPABASE_URL)      miss.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) miss.push('SUPABASE_ANON_KEY');
  if (miss.length) {
    console.error('Missing env vars: ' + miss.join(', '));
    // keep server up for debugging; do not exit
  }
}

// ==== Runtime state ====
let botClient = null;
let isReady = false;
let qrBase64 = null; // raw base64 only (no data URL prefix)
let connectionStatus = DISABLE_VENOM ? 'disabled' : 'disconnected';
let lastError = null;

// ==== Helpers ====
function toRawBase64(maybeDataUrl) {
  if (!maybeDataUrl) return null;
  const i = maybeDataUrl.indexOf('base64,');
  return i >= 0 ? maybeDataUrl.slice(i + 'base64,'.length) : maybeDataUrl;
}
function toDataUrlPNG(base64) {
  return base64 ? 'data:image/png;base64,' + base64 : null;
}

// ==== HTTP server ====
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', function (_req, res) {
  res.json({ ok: true, message: 'Bot is alive' });
});

app.get('/health', function (_req, res) {
  res.json({
    ok: isReady || DISABLE_VENOM,
    status: isReady ? 'ready' : (DISABLE_VENOM ? 'disabled' : 'not_ready'),
    business_phone: BUSINESS_PHONE || null,
    timestamp: new Date().toISOString()
  });
});

app.get('/status', function (_req, res) {
  res.json({
    status: connectionStatus,
    isReady: isReady,
    businessPhone: BUSINESS_PHONE || null,
    hasQR: !!qrBase64,
    lastError: lastError,
    timestamp: new Date().toISOString()
  });
});

app.get('/qr', function (_req, res) {
  if (!qrBase64) return res.status(404).json({ error: 'No QR code available' });
  res.json({ base64: qrBase64, dataUrl: toDataUrlPNG(qrBase64) });
});

app.get('/qr.png', function (_req, res) {
  if (!qrBase64) return res.status(404).send('No QR code available');
  const buf = Buffer.from(qrBase64, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(buf);
});

// Simple HTML viewer (no template literals to avoid hidden RTL chars)
app.get('/qr-view', function (_req, res) {
  const html = [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>WhatsApp QR</title>',
    '<style>',
    '  body{font-family:system-ui,Arial;margin:24px}',
    '  #img{width:340px;height:340px;border:1px solid #ddd;object-fit:contain;image-rendering:pixelated}',
    '  #status{margin:8px 0;color:#555}',
    '  pre{background:#f6f8fa;border:1px solid #e5e7eb;padding:12px;border-radius:8px;max-width:620px;overflow:auto}',
    '</style>',
    '</head><body>',
    '  <h1>WhatsApp Linking</h1>',
    '  <div id="status">Waiting for QR…</div>',
    '  <img id="img" alt="QR will appear here"/>',
    '  <pre id="meta"></pre>',
    '  <script>',
    '    async function tick(){',
    '      try{',
    "        const st = await fetch('/status',{cache:'no-store'}).then(r=>r.json());",
    '        const lines = [',
    "          'status: ' + st.status,",
    "          'isReady: ' + st.isReady,",
    "          'hasQR: ' + st.hasQR,",
    "          'businessPhone: ' + st.businessPhone,",
    "          st.lastError ? ('lastError: ' + st.lastError) : ''",
    '        ].filter(Boolean).join(\"\\n\");',
    "        document.getElementById('meta').textContent = lines;",
    '      }catch(e){}',
    '      try{',
    "        const r = await fetch('/qr.png?ts=' + Date.now(), {cache:'no-store'});",
    '        if (r.ok) {',
    "          document.getElementById('img').src = '/qr.png?ts=' + Date.now();",
    "          document.getElementById('status').textContent = 'Open WhatsApp > Linked devices > Link a device and scan the code';",
    '        } else {',
    "          document.getElementById('img').removeAttribute('src');",
    "          document.getElementById('status').textContent = 'No QR yet (auto-refresh every 3s)…';",
    '        }',
    '      }catch(e){',
    "        document.getElementById('status').textContent = 'Error: ' + e.message;",
    '      }',
    '    }',
    '    tick();',
    '    setInterval(tick, 3000);',
    '  </script>',
    '</body></html>'
  ].join('\n');
  res.type('html').send(html);
});

app.listen(PORT, '0.0.0.0', function () {
  console.log('Server on :' + PORT + ' | DISABLE_VENOM=' + DISABLE_VENOM);
});

// ==== Supabase helper (skips if envs are missing) ====
async function callSupabaseFunction(fn, data, retries) {
  retries = retries || 3;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return { ok: true, skipped: true };
  const url = SUPABASE_URL + '/functions/v1/' + fn;
  for (let i = 1; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify(data)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + r.statusText);
      return await r.json();
    } catch (e) {
      console.error('Supabase ' + fn + ' attempt ' + i + '/' + retries + ':', e.message);
      lastError = 'Supabase ' + fn + ': ' + e.message;
      if (i === retries) throw e;
      await new Promise(function (res) { setTimeout(res, Math.pow(2, i) * 1000); });
    }
  }
}

// ==== Venom (guarded by DISABLE_VENOM) ====
if (!DISABLE_VENOM) {
  console.log('Starting Venom…');
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
    catchQR: function (base64, _ascii, attempts) {
      console.log('QR generated. attempt=' + attempts);
      qrBase64 = toRawBase64(base64);
      connectionStatus = 'qr_ready';
    },
    statusCallback: function (statusSession) {
      console.log('Venom status: ' + statusSession);
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
  .then(function (client) {
    botClient = client;
    console.log('Venom ready. Waiting for messages…');

    client.onMessage(async function (message) {
      try {
        if (message.isGroupMsg || message.from === 'status@broadcast' || message.fromMe) return;

        // Simple reply
        await client.sendText(message.from, 'Hi! The bot is live 🚀');

        // Example log to Supabase (if envs exist)
        await callSupabaseFunction('bot-message', {
          user_id: message.from,
          message: message.body,
          message_type: 'incoming',
          business_phone: BUSINESS_PHONE
        }).catch(function () {});
      } catch (e) {
        console.error('onMessage error:', e);
        lastError = 'onMessage: ' + e.message;
      }
    });
  })
  .catch(function (e) {
    console.error('Venom failed to start:', e);
    lastError = 'startup: ' + e.message;
    connectionStatus = 'error';
  });
} else {
  console.log('Safe mode: Venom is disabled. Only HTTP endpoints are up.');
}

// ==== graceful shutdown ====
async function shutdown(signal) {
  console.log('\n' + signal + ' received');
  try { if (botClient) await botClient.close(); } catch (e) {}
  process.exit(0);
}
['SIGINT', 'SIGTERM', 'SIGUSR2'].forEach(function (s) { process.on(s, function () { shutdown(s); }); });
process.on('unhandledRejection', function (r) { console.error('UnhandledRejection:', r); lastError = 'unhandledRejection: ' + r; });
process.on('uncaughtException', function (e) { console.error('UncaughtException:', e); lastError = 'uncaughtException: ' + e.message; });
