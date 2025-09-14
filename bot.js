// ===== Production-ready WhatsApp bot (Express + Venom) - Clean Fixed Version =====

// Use native fetch (Node 18+). Fallback to node-fetch only if missing.
if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = (...args) =>
    import('node-fetch').then(({ default: f }) => f(...args));
}

const express = require('express');
const cors = require('cors');
const venom = require('venom-bot');
const fs = require('fs');
const path = require('path');

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

// Request rate limiting
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 requests per minute

// ---------- Utility Functions ----------
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

function cleanMessageCache() {
  if (processedMessages.size > MESSAGE_CACHE_SIZE) {
    const entries = Array.from(processedMessages);
    processedMessages.clear();
    entries.slice(-MESSAGE_CACHE_SIZE / 2).forEach(entry => processedMessages.add(entry));
    console.log('Message cache cleaned');
  }
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

// ---------- HTTP Server Setup ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Rate limiting middleware
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

// ---------- API Endpoints ----------
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

// Debug endpoint
app.get('/debug', (_req, res) => {
  const sessionPath = path.join(__dirname, 'tokens', SESSION_NAME);
  
  res.json({
    status: connectionStatus,
    isReady,
    hasQR: !!qrBase64,
    lastError,
    reconnectAttempts,
    sessionName: SESSION_NAME,
    sessionExists: fs.existsSync(sessionPath),
    processedMessagesCount: processedMessages.size,
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      businessPhone: BUSINESS_PHONE,
      headless: HEADLESS,
      disableVenom: DISABLE_VENOM
    },
    timestamp: new Date().toISOString()
  });
});

// Session cleanup endpoint
app.post('/reset-session', (_req, res) => {
  if (DISABLE_VENOM) {
    return res.json({ error: 'Venom is disabled' });
  }
  
  try {
    // Close existing client
    if (botClient) {
      botClient.close().catch(() => {});
    }
    
    // Reset state
    botClient = null;
    isReady = false;
    qrBase64 = null;
    connectionStatus = 'disconnected';
    lastError = null;
    reconnectAttempts = 0;
    processedMessages.clear();
    
    // Try to delete session files (this might fail, that's ok)
    const sessionPath = path.join(__dirname, 'tokens', SESSION_NAME);
    
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log('Session files deleted');
    }
    
    // Restart Venom after a delay
    setTimeout(() => {
      initializeVenom();
    }, 2000);
    
    res.json({ 
      success: true, 
      message: 'Session reset, restarting in 2 seconds...' 
    });
  } catch (e) {
    console.error('Session reset failed:', e);
    res.status(500).json({ error: 'Reset failed: ' + e.message });
  }
});

// QR as JSON (base64 + data URL)
app.get('/qr', (_req, res) => {
  if (!qrBase64) return res.status(404).json({ error: 'No QR code available' });
  res.json({ base64: qrBase64, dataUrl: 'data:image/png;base64,' + qrBase64 });
});

// QR as a clean PNG with enhanced quality for crisp edges
app.get('/qr.png', (_req, res) => {
  if (!qrBase64) return res.status(404).send('No QR code available');
  
  try {
    const buf = Buffer.from(qrBase64, 'base64');
    
    // Set headers for optimal image delivery
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Transfer-Encoding', 'binary');
    res.setHeader('Accept-Ranges', 'bytes');
    
    res.send(buf);
  } catch (e) {
    console.error('QR PNG generation error:', e);
    res.status(500).send('QR generation failed');
  }
});

// QR viewer page with enhanced UI and controls
app.get('/qr-view', (_req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp QR</title>
<style>
  body{font-family:system-ui,Arial;margin:0;padding:24px;background:#f9fafb;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .container{max-width:500px;width:100%;padding:32px;background:white;border-radius:12px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1)}
  .qr-container{display:flex;justify-content:center;align-items:center;margin:24px 0;padding:24px;background:#000000;border-radius:20px;box-shadow:0 8px 24px rgba(0,0,0,0.2);max-width:448px;margin-left:auto;margin-right:auto}
  #img{
    width:400px;
    height:400px;
    border:none;
    object-fit:contain;
    image-rendering:-moz-crisp-edges;
    image-rendering:-webkit-optimize-contrast;
    image-rendering:-webkit-crisp-edges;
    image-rendering:pixelated;
    image-rendering:crisp-edges;
    image-rendering:optimize-contrast;
    -ms-interpolation-mode:nearest-neighbor;
    display:block;
    background:white;
    margin:0;
    padding:12px;
    border-radius:8px;
    transform:rotate(180deg);
    image-orientation:from-image;
    max-width:400px;
    max-height:400px;
    min-width:400px;
    min-height:400px
  }
  #status{margin:16px 0;padding:16px;background:#f3f4f6;border-radius:8px;text-align:center;color:#374151;font-weight:500}
  .connected{background:#d1fae5;color:#065f46;border:1px solid #a7f3d0}
  .error{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}
  .waiting{background:#fef3c7;color:#92400e;border:1px solid #fcd34d}
  .qr-controls{display:none;text-align:center;margin:16px 0}
  .qr-controls button{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin:0 4px;transition:all 0.2s}
  .btn-primary{background:#3b82f6;color:white}
  .btn-primary:hover{background:#2563eb}
  .btn-danger{background:#ef4444;color:white}
  .btn-danger:hover{background:#dc2626}
  pre{background:#f6f8fa;border:1px solid #e5e7eb;padding:12px;border-radius:8px;max-width:100%;overflow:auto;font-size:11px;line-height:1.4}
  .refresh-info{font-size:13px;color:#6b7280;text-align:center;margin-top:16px;opacity:0.8}
  h1{text-align:center;color:#1f2937;margin:0 0 24px 0;font-size:24px}
  .instructions{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;padding:12px;border-radius:8px;margin:16px 0;font-size:14px;text-align:center;display:none}
</style>
</head><body>
  <div class="container">
    <h1>WhatsApp Bot Setup</h1>
    <div id="status">Initializing...</div>
    
    <div class="qr-container" id="qr-container" style="display:none;">
      <img id="img" alt="QR Code will appear here"/>
    </div>
    
    <div class="qr-controls" id="qr-controls">
      <button onclick="rotateQR()" class="btn-primary">
        🔄 Rotate QR Code
      </button>
      <button onclick="resetSession()" class="btn-danger">
        🔥 Reset Session
      </button>
      <div style="font-size:12px;color:#6b7280;margin-top:8px;">
        Rotate if tilted • Reset if "couldn't connect device" error
      </div>
    </div>
    
    <div class="instructions" id="instructions">
      📱 <strong>How to connect:</strong><br>
      1. Open WhatsApp on your phone<br>
      2. Go to Settings → Linked Devices<br>
      3. Tap "Link a Device"<br>
      4. Scan the QR code above
    </div>
    
    <pre id="meta"></pre>
    <div class="refresh-info">Auto-refresh every 3 seconds</div>
  </div>
  
  <script>
    let intervalId;
    let isConnected = false;
    let currentRotation = 180; // Start with 180deg since that's the common issue
    
    function rotateQR() {
      const imgEl = document.getElementById('img');
      currentRotation = (currentRotation + 90) % 360;
      imgEl.style.transform = \`rotate(\${currentRotation}deg)\`;
      console.log('QR rotated to:', currentRotation + 'deg');
    }
    
    async function resetSession() {
      if (!confirm('Reset WhatsApp session? This will clear all connection data and generate a new QR code.')) {
        return;
      }
      
      const statusEl = document.getElementById('status');
      statusEl.textContent = '🔥 Resetting session...';
      statusEl.className = 'waiting';
      document.getElementById('qr-container').style.display = 'none';
      document.getElementById('instructions').style.display = 'none';
      
      try {
        const response = await fetch('/reset-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
          statusEl.textContent = '✅ Session reset! New QR will appear in a few seconds...';
          // Resume polling for new QR
          if (!intervalId && !isConnected) {
            intervalId = setInterval(tick, 3000);
          }
        } else {
          statusEl.textContent = '❌ Reset failed. Check server logs.';
          statusEl.className = 'error';
        }
      } catch (e) {
        console.error('Reset failed:', e);
        statusEl.textContent = '❌ Reset request failed: ' + e.message;
        statusEl.className = 'error';
      }
    }
    
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
        const qrContainer = document.getElementById('qr-container');
        const instructions = document.getElementById('instructions');
        const controls = document.getElementById('qr-controls');
        
        // Handle different connection states
        if (st.status === 'connected') {
          if (!isConnected) {
            statusEl.textContent = '✅ WhatsApp is connected and ready!';
            statusEl.className = 'connected';
            qrContainer.style.display = 'none';
            instructions.style.display = 'none';
            controls.style.display = 'none';
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
          statusEl.textContent = '❌ Connection failed. Check logs or try Reset Session.';
          statusEl.className = 'error';
          qrContainer.style.display = 'none';
          instructions.style.display = 'none';
          controls.style.display = 'block';
        } else if (st.hasQR) {
          statusEl.textContent = '📱 Ready to scan QR code';
          statusEl.className = 'waiting';
          qrContainer.style.display = 'flex';
          controls.style.display = 'block';
          instructions.style.display = 'block';
        } else {
          statusEl.textContent = '⏳ Generating QR code...';
          statusEl.className = 'waiting';
          qrContainer.style.display = 'none';
          controls.style.display = 'block';
          instructions.style.display = 'none';
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
            // Force reload with timestamp to prevent caching issues
            const timestamp = Date.now();
            imgEl.src = '';  // Clear first
            setTimeout(() => {
              imgEl.src = \`/qr.png?v=\${timestamp}\`;
              imgEl.style.transform = \`rotate(\${currentRotation}deg)\`; // Apply current rotation
              imgEl.onload = function() {
                document.getElementById('qr-container').style.display = 'flex';
                console.log('QR loaded successfully');
              };
              imgEl.onerror = function() {
                console.error('QR image failed to load');
                document.getElementById('qr-container').style.display = 'none';
              };
            }, 100);
          } else {
            document.getElementById('qr-container').style.display = 'none';
          }
        } catch(e) {
          console.error('QR fetch failed:', e);
          document.getElementById('qr-container').style.display = 'none';
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
async function callSupabaseFunction(fn, data, retries = 3) {
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
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--force-device-scale-factor=1',
      '--high-dpi-support=1',
      '--disable-smooth-scrolling',
      '--disable-extensions',
      '--disable-plugins',
      '--disable-images=false',
      '--enable-logging',
      '--ignore-certificate-errors',
      '--ignore-ssl-errors',
      '--ignore-certificate-errors-spki-list'
    ],
    puppeteerOptions: { 
      executablePath: PUP_EXEC_PATH,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--force-device-scale-factor=1',
        '--disable-font-subpixel-positioning'
      ],
      defaultViewport: {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false
      }
    },
    catchQR: onQR,
    qrCallback: onQR,
    statusCallback: function (statusSession, session) {
      console.log('Venom status:', statusSession, session ? 'Session: ' + session : '');
      
      switch(statusSession) {
        case 'isLogged':
          connectionStatus = 'connected';
          qrBase64 = null;
          isReady = true;
          reconnectAttempts = 0;
          lastError = null;
          console.log('✅ WhatsApp connected successfully!');
          break;
        case 'notLogged':
          connectionStatus = 'disconnected';
          isReady = false;
          console.log('❌ Not logged in to WhatsApp');
          break;
        case 'qrReadSuccess':
          connectionStatus = 'connecting';
          console.log('📱 QR code scanned, connecting...');
          break;
        case 'qrReadFail':
          connectionStatus = 'qr_failed';
          lastError = 'QR scan failed - please try again';
          console.log('❌ QR scan failed');
          break;
        case 'autocloseCalled':
          connectionStatus = 'disconnected';
          isReady = false;
          console.log('🔄 Auto-close called, reconnecting...');
          break;
        case 'desconnectedMobile':
          connectionStatus = 'mobile_disconnected';
          isReady = false;
          lastError = 'Phone disconnected from internet';
          console.log('📵 Mobile phone disconnected');
          break;
        case 'deleteToken':
          connectionStatus = 'token_deleted';
          isReady = false;
          lastError = 'Session token deleted';
          console.log('🗑️ Session token deleted');
          break;
        case 'browserClose':
          connectionStatus = 'disconnected';
          isReady = false;
          console.log('🌐 Browser closed');
          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            scheduleReconnect();
          }
          break;
        case 'qrReadError':
          connectionStatus = 'qr_error';
          lastError = 'QR code read error';
          console.log('❌ QR code read error');
          break;
        default:
          console.log('ℹ️ Unknown status:', statusSession);
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
