// ===== Production-ready WhatsApp bot (Express + Venom) - Fixed Version =====


// --- fix for Node18 where global File may be missing (needed by cheerio's undici) ---
if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File {}; // minimal stub is enough for module load
}
if (typeof globalThis.Blob === 'undefined') {
  globalThis.Blob = require('buffer').Blob; // safe fallback
}
// (optional, only if you later see FormData errors)
// if (typeof globalThis.FormData === 'undefined') {
//   globalThis.FormData = class FormData {};
// }

// now your existing requires:
const express = require('express');
const cors = require('cors');
const venom = require('venom-bot');


// Use native fetch (Node 18+). Fallback to node-fetch only if missing.
if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = (...args) =>
    import('node-fetch').then(({ default: f }) => f(...args));
}

const express = require('express');
const cors = require('cors');
const venom = require('venom-bot');

// ---------- Config (from ENV) ----------
const BUSINESS_PHONE = process.env.BUSINESS_PHONE;
const SESSION_NAME = process.env.SESSION_NAME || 'mamaz-ai-bot';
const HEADLESS = process.env.HEADLESS !== 'false';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PUP_EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const PORT = process.env.PORT || 3000;
const DISABLE_VENOM = String(process.env.DISABLE_VENOM || 'false').toLowerCase() === 'true';

// ---------- Environment Validation ----------
function validateEnvironment() {
  const errors = [];
  
  if (!DISABLE_VENOM) {
    if (!BUSINESS_PHONE) errors.push('BUSINESS_PHONE is required');
    if (!SUPABASE_URL) errors.push('SUPABASE_URL is required');
    if (!SUPABASE_ANON_KEY) errors.push('SUPABASE_ANON_KEY is required');
    
    // Validate phone format
    if (BUSINESS_PHONE && !BUSINESS_PHONE.match(/^\+\d{10,15}$/)) {
      errors.push('BUSINESS_PHONE must be in format +1234567890');
    }
    
    // Validate Supabase URL
    if (SUPABASE_URL && !SUPABASE_URL.startsWith('https://')) {
      errors.push('SUPABASE_URL must be a valid HTTPS URL');
    }
  }
  
  const port = parseInt(PORT);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push('PORT must be a valid port number');
  }
  
  if (errors.length > 0) {
    console.error('Environment validation failed:');
    errors.forEach(error => console.error('  -', error));
    process.exit(1);
  }
}

validateEnvironment();

// ---------- Runtime state ----------
let botClient = null;
let isReady = false;
let qrBase64 = null;
let connectionStatus = DISABLE_VENOM ? 'disabled' : 'disconnected';
let lastError = null;
let reconnectAttempts = 0;

// Message deduplication
const processedMessages = new Set();
const MESSAGE_CACHE_SIZE = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;

// ---------- Helpers ----------
function toRawBase64(maybeDataUrl) {
  if (!maybeDataUrl) return null;
  const i = maybeDataUrl.indexOf('base64,');
  return i >= 0 ? maybeDataUrl.slice(i + 'base64,'.length) : maybeDataUrl;
}

function toJid(input) {
  if (!input || typeof input !== 'string') return null;
  if (input.includes('@')) return input;
  
  // More robust phone number validation
  let digits = input.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null; // Invalid length
  
  // Israeli number example - adapt for your country
  if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 10) {
    digits = '972' + digits.slice(1);
  }
  
  return digits + '@c.us';
}

function safeExtractText(message) {
  if (!message || typeof message.body !== 'string') return '';
  return message.body.trim().slice(0, 1000); // Limit message length
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('Max reconnection attempts reached');
    connectionStatus = 'failed';
    return;
  }
  
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Max 30s
  reconnectAttempts++;
  
  setTimeout(() => {
    console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
    initializeVenom();
  }, delay);
}

// Clean message cache to prevent memory leaks
function cleanMessageCache() {
  if (processedMessages.size > MESSAGE_CACHE_SIZE) {
    const entries = Array.from(processedMessages);
    processedMessages.clear();
    entries.slice(-MESSAGE_CACHE_SIZE / 2).forEach(entry => processedMessages.add(entry));
    console.log('Message cache cleaned');
  }
}

// ---------- HTTP Server ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Basic rate limiting middleware
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 requests per minute

app.use((req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  
  if (!requestCounts.has(clientIP)) {
    requestCounts.set(clientIP, []);
  }
  
  const requests = requestCounts.get(clientIP);
  // Remove old requests
  const recentRequests = requests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
  requestCounts.set(clientIP, recentRequests);
  
  if (recentRequests.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  recentRequests.push(now);
  next();
});

// Health & status
app.get('/', (_req, res) => res.json({ ok: true, message: 'Bot is alive' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: isReady || DISABLE_VENOM,
    status: isReady ? 'ready' : (DISABLE_VENOM ? 'disabled' : 'not_ready'),
    business_phone: BUSINESS_PHONE || null,
    reconnect_attempts: reconnectAttempts,
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (_req, res) => {
  res.json({
    status: connectionStatus,
    isReady,
    businessPhone: BUSINESS_PHONE || null,
    hasQR: !!qrBase64,
    lastError,
    reconnectAttempts,
    timestamp: new Date().toISOString()
  });
});

// QR as JSON (base64 + data URL)
app.get('/qr', (_req, res) => {
  if (!qrBase64) return res.status(404).json({ error: 'No QR code available' });
  res.json({ base64: qrBase64, dataUrl: 'data:image/png;base64,' + qrBase64 });
});

// QR as a clean PNG
app.get('/qr.png', (_req, res) => {
  if (!qrBase64) return res.status(404).send('No QR code available');
  const buf = Buffer.from(qrBase64, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(buf);
});

// Fixed QR viewer page with proper cleanup
app.get('/qr-view', (_req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp QR</title>
<style>
  body{font-family:system-ui,Arial;margin:24px;background:#f9fafb}
  .container{max-width:500px;margin:0 auto;padding:20px;background:white;border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1)}
  #img{width:300px;height:300px;border:2px solid #e5e7eb;border-radius:8px;object-fit:contain;image-rendering:pixelated;display:block;margin:0 auto}
  #status{margin:16px 0;padding:12px;background:#f3f4f6;border-radius:8px;text-align:center;color:#374151}
  .connected{background:#d1fae5;color:#065f46}
  .error{background:#fee2e2;color:#991b1b}
  pre{background:#f6f8fa;border:1px solid #e5e7eb;padding:12px;border-radius:8px;max-width:100%;overflow:auto;font-size:12px}
  .refresh-info{font-size:14px;color:#6b7280;text-align:center;margin-top:16px}
</style>
</head><body>
  <div class="container">
    <h1>WhatsApp Bot Status</h1>
    <div id="status">Initializing...</div>
    <img id="img" alt="QR will appear here" style="display:none;"/>
    <pre id="meta"></pre>
    <div class="refresh-info">Auto-refresh every 3 seconds</div>
  </div>
  
  <script>
    let intervalId;
    let isConnected = false;
    
    async function tick(){
      try{
        const st = await fetch('/status',{cache:'no-store'}).then(r=>r.json());
        const lines = [
          'Status: ' + st.status,
          'Ready: ' + st.isReady,
          'Has QR: ' + st.hasQR,
          'Business Phone: ' + (st.businessPhone || 'Not set'),
          'Reconnect Attempts: ' + (st.reconnectAttempts || 0),
          st.lastError ? ('Last Error: ' + st.lastError) : '',
          'Last Updated: ' + new Date(st.timestamp).toLocaleString()
        ].filter(Boolean).join('\\n');
        document.getElementById('meta').textContent = lines;
        
        const statusEl = document.getElementById('status');
        const imgEl = document.getElementById('img');
        
        // Handle different connection states
        if (st.status === 'connected') {
          if (!isConnected) {
            statusEl.textContent = '✅ WhatsApp is connected and ready!';
            statusEl.className = 'connected';
            imgEl.style.display = 'none';
            isConnected = true;
            
            // Stop polling after connection
            if (intervalId) {
              clearInterval(intervalId);
              intervalId = null;
              console.log('Stopped polling - WhatsApp connected');
            }
          }
          return;
        } else if (st.status === 'error' || st.status === 'failed') {
          statusEl.textContent = '❌ Connection failed. Check logs for details.';
          statusEl.className = 'error';
          imgEl.style.display = 'none';
        } else if (st.hasQR) {
          statusEl.textContent = '📱 Open WhatsApp → Linked devices → Link a device and scan the code';
          statusEl.className = '';
          imgEl.style.display = 'block';
        } else {
          statusEl.textContent = '⏳ Waiting for QR code...';
          statusEl.className = '';
          imgEl.style.display = 'none';
        }
        
        isConnected = false;
      } catch(e) {
        console.error('Status check failed:', e);
        document.getElementById('status').textContent = '❌ Cannot connect to bot server';
        document.getElementById('status').className = 'error';
      }
      
      // Try to load QR image
      if (!isConnected) {
        try{
          const r = await fetch('/qr.png?ts=' + Date.now(), {cache:'no-store'});
          const imgEl = document.getElementById('img');
          if (r.ok) {
            imgEl.src = '/qr.png?ts=' + Date.now();
            imgEl.style.display = 'block';
          } else {
            imgEl.style.display = 'none';
          }
        } catch(e) {
          console.error('QR fetch failed:', e);
        }
      }
    }
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    });
    
    // Handle page visibility changes to pause/resume polling
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      } else if (!isConnected && !intervalId) {
        tick();
        intervalId = setInterval(tick, 3000);
      }
    });
    
    // Initial tick and start interval
    tick();
    intervalId = setInterval(tick, 3000);
  </script>
</body></html>`);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} | DISABLE_VENOM=${DISABLE_VENOM}`);
});

// ---------- Enhanced Supabase helper ----------
async function callSupabaseFunction(fn, data, retries) {
  retries = retries || 3;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn(`Supabase not configured, skipping ${fn}`);
    return { ok: true, skipped: true };
  }
  
  const url = SUPABASE_URL + '/functions/v1/' + fn;
  let lastError;
  
  for (let i = 1; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
      
      const r = await fetch(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY 
        },
        body: JSON.stringify(data),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!r.ok) {
        const errorText = await r.text();
        throw new Error(`HTTP ${r.status}: ${errorText}`);
      }
      return await r.json();
    } catch (e) {
      lastError = e;
      console.error(`Supabase ${fn} attempt ${i}/${retries}:`, e.message);
      if (i === retries) break;
      await new Promise(res => setTimeout(res, Math.pow(2, i) * 1000));
    }
  }
  
  // Don't throw - just log and continue
  console.error(`Supabase ${fn} failed after ${retries} attempts:`, lastError.message);
  return { ok: false, error: lastError.message };
}

async function getAIReply(userId, text) {
  try {
    const resp = await callSupabaseFunction('get-reply', {
      user_id: userId, 
      message: text, 
      business_phone: BUSINESS_PHONE
    });
    
    if (resp && resp.ok && typeof resp.reply === 'string' && resp.reply.trim()) {
      return resp.reply;
    }
  } catch (e) {
    console.error('AI reply failed:', e.message);
  }
  return 'Hi! I am live 🚀';
}

// ---------- Enhanced Venom Integration ----------
function initializeVenom() {
  if (DISABLE_VENOM) {
    console.log('Safe mode: Venom is disabled. Only HTTP endpoints are up.');
    return;
  }

  console.log('Starting Venom...');
  connectionStatus = 'connecting';

  const onQR = function (base64, _ascii, attempts) {
    console.log(`QR generated (attempt ${attempts})`);
    qrBase64 = toRawBase64(base64);
    connectionStatus = 'qr_ready';
    lastError = null; // Clear previous errors when QR is ready
  };

  venom.create({
    session: SESSION_NAME,
    headless: HEADLESS,
    useChrome: false,
    folderNameToken: 'tokens',
    disableWelcome: true,
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
    catchQR: onQR,
    qrCallback: onQR,
    statusCallback: function (statusSession) {
      console.log('Venom status:', statusSession);
      
      switch(statusSession) {
        case 'isLogged':
          connectionStatus = 'connected';
          qrBase64 = null;
          isReady = true;
          reconnectAttempts = 0; // Reset on successful connection
          lastError = null;
          break;
        case 'notLogged':
          connectionStatus = 'disconnected';
          isReady = false;
          break;
        case 'qrReadSuccess':
          connectionStatus = 'connecting';
          break;
        case 'browserClose':
          connectionStatus = 'disconnected';
          isReady = false;
          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            console.log('Browser closed, scheduling reconnect...');
            scheduleReconnect();
          }
          break;
      }
    }
  })
  .then(function (client) {
    botClient = client;
    console.log('Venom ready. Waiting for messages...');

    client.onMessage(async function (message) {
      try {
        // Ignore groups, status broadcast, and self
        if (message.isGroupMsg || message.from === 'status@broadcast' || message.fromMe) return;

        // Extract and validate message text
        const text = safeExtractText(message);
        if (!text) return; // Skip empty messages

        // Prevent duplicate processing
        const messageKey = `${message.id}_${message.timestamp}`;
        if (processedMessages.has(messageKey)) return;
        
        processedMessages.add(messageKey);
        cleanMessageCache(); // Clean cache periodically

        const userId = message.from;
        console.log(`Processing message from ${userId}: ${text.substring(0, 50)}...`);

        // Get AI reply
        const reply = await getAIReply(userId, text);
        await client.sendText(userId, reply);

        console.log(`Sent reply to ${userId}: ${reply.substring(0, 50)}...`);

        // Log messages to Supabase (best-effort)
        callSupabaseFunction('bot-message', {
          user_id: userId, 
          message: text, 
          message_type: 'incoming', 
          business_phone: BUSINESS_PHONE,
          timestamp: new Date().toISOString()
        }).catch(() => {});
        
        callSupabaseFunction('bot-message', {
          user_id: userId, 
          message: reply, 
          message_type: 'outgoing', 
          business_phone: BUSINESS_PHONE,
          timestamp: new Date().toISOString()
        }).catch(() => {});

      } catch (e) {
        console.error('onMessage error:', e);
        lastError = 'onMessage: ' + e.message;
      }
    });

    // Handle client disconnection
    client.onStateChange((state) => {
      console.log('Client state changed:', state);
      if (state === 'DISCONNECTED') {
        isReady = false;
        connectionStatus = 'disconnected';
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          scheduleReconnect();
        }
      }
    });

  })
  .catch(function (e) {
    console.error('Venom failed to start:', e);
    lastError = 'startup: ' + e.message;
    connectionStatus = 'error';
    
    // Schedule reconnect attempt
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      scheduleReconnect();
    }
  });
}

// Start Venom
initializeVenom();

// ---------- Enhanced graceful shutdown ----------
async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  
  try {
    if (botClient) {
      console.log('Closing WhatsApp client...');
      await botClient.close();
    }
  } catch (e) {
    console.error('Error closing bot client:', e.message);
  }
  
  // Clear any intervals/timeouts
  processedMessages.clear();
  requestCounts.clear();
  
  console.log('Shutdown complete');
  process.exit(0);
}

// Handle various shutdown signals
['SIGINT', 'SIGTERM', 'SIGUSR2'].forEach(signal => {
  process.on(signal, () => shutdown(signal));
});

// Enhanced error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  lastError = 'unhandledRejection: ' + String(reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  lastError = 'uncaughtException: ' + error.message;
  
  // Don't exit immediately on uncaught exceptions in production
  // Log the error and continue running
  console.log('Process continuing...');
});

// Periodic cleanup
setInterval(() => {
  // Clean old rate limit data
  const now = Date.now();
  for (const [ip, requests] of requestCounts.entries()) {
    const recent = requests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
    if (recent.length === 0) {
      requestCounts.delete(ip);
    } else {
      requestCounts.set(ip, recent);
    }
  }
  
  cleanMessageCache();
}, 300000); // Every 5 minutes
