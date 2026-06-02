// DecoBot Backend Server
// Runs with plain Node.js. No npm install is required.

const http = require('http');
const fs = require('fs');
const path = require('path');

loadEnvFile('.env');
loadEnvFile('KEY-API.env');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_FILE = path.join(__dirname, 'analytics.jsonl');
const rateLimitStore = new Map();

function loadEnvFile(fileName) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    value = value.replace(/^["']|["']$/g, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders()
  });
  res.end(JSON.stringify(data));
}

function corsHeaders() {
  const origins = process.env.ALLOWED_ORIGINS;
  return {
    'Access-Control-Allow-Origin': origins ? origins.split(',')[0].trim() : '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('Request body is too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function logEvent(event) {
  try {
    const line = JSON.stringify({ ...event, ts: Date.now() }) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // Analytics must never break chat responses.
  }
}

function normalizeFetchError(err) {
  const code = err.cause?.code || err.code;
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || /fetch failed/i.test(err.message)) {
    return Object.assign(
      new Error('اتصال به سرویس AI برقرار نشد. آدرس API در دسترس نیست یا اینترنت/VPN/فایروال اجازه اتصال نمی‌دهد.'),
      { status: 502 }
    );
  }

  return err;
}

function getAiConfig() {
  if (process.env.OPENAI_API_KEY || process.env.AI_API_KEY) {
    const baseUrl = process.env.OPENAI_BASE_URL || process.env.AI_BASE_URL || 'https://api.openai.com/v1';
    return {
      provider: process.env.AI_PROVIDER || 'openai-compatible',
      apiKey: process.env.OPENAI_API_KEY || process.env.AI_API_KEY,
      baseUrl: baseUrl.replace(/\/$/, ''),
      endpointPath: process.env.AI_ENDPOINT_PATH || '/chat/completions',
      model: process.env.AI_MODEL || 'gpt-4o-mini'
    };
  }

  if (process.env.DEEPSEEK_API_KEY) {
    return {
      provider: 'deepseek',
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
      endpointPath: process.env.AI_ENDPOINT_PATH || '/chat/completions',
      model: process.env.AI_MODEL || 'deepseek-chat'
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: 'https://api.anthropic.com',
      model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001'
    };
  }

  return null;
}

function validateAiHost(config) {
  const allowedHost = process.env.AI_ALLOWED_HOST;
  if (!allowedHost || !config?.baseUrl) return;

  const configuredHost = new URL(config.baseUrl).hostname;
  if (configuredHost !== allowedHost) {
    throw Object.assign(
      new Error(`AI host is locked to ${allowedHost}, but config uses ${configuredHost}`),
      { status: 500 }
    );
  }
}

function checkRateLimit(req) {
  const limit = parseInt(process.env.RATE_LIMIT_REQUESTS, 10) || 30;
  const windowMs = (parseInt(process.env.RATE_LIMIT_MINUTES, 10) || 60) * 60 * 1000;
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = rateLimitStore.get(ip);

  if (!current || now - current.startedAt > windowMs) {
    rateLimitStore.set(ip, { count: 1, startedAt: now });
    return true;
  }

  current.count += 1;
  return current.count <= limit;
}

async function callAi({ messages, system }) {
  const config = getAiConfig();
  const maxTokens = parseInt(process.env.MAX_TOKENS, 10) || 1000;

  if (!config) {
    throw Object.assign(new Error('API key is not configured'), { status: 500 });
  }

  validateAiHost(config);

  if (config.provider !== 'anthropic') {
    const chatMessages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    let response;
    try {
      response = await fetch(`${config.baseUrl}${config.endpointPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: maxTokens,
          messages: chatMessages
        })
      });
    } catch (err) {
      throw normalizeFetchError(err);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMsg = response.status === 524
        ? 'سرویس Agnes دیر پاسخ داد و timeout شد. چند لحظه بعد دوباره امتحان کن یا مدل سبک‌تر انتخاب کن.'
        : data.error?.message || `HTTP ${response.status}`;
      throw Object.assign(new Error(errMsg), { status: response.status });
    }

    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0
      },
      provider: config.provider
    };
  }

  let response;
  try {
    response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        system: system || '',
        messages: messages.map(m => ({
          role: m.role,
          content: m.content
        }))
      })
    });
  } catch (err) {
    throw normalizeFetchError(err);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errMsg = data.error?.message || `HTTP ${response.status}`;
    throw Object.assign(new Error(errMsg), { status: response.status });
  }

  const content = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  return {
    content,
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0
    },
    provider: config.provider
  };
}

async function handleChat(req, res) {
  try {
    if (!checkRateLimit(req)) {
      return sendJson(res, 429, {
        error: 'تعداد درخواست‌ها زیاد شده. چند دقیقه بعد دوباره امتحان کن.'
      });
    }

    const body = await readBody(req);
    const { messages, system } = JSON.parse(body || '{}');

    if (!messages || !Array.isArray(messages)) {
      return sendJson(res, 400, { error: 'messages باید آرایه باشد' });
    }

    if (messages.length === 0) {
      return sendJson(res, 400, { error: 'messages خالی است' });
    }

    const aiConfig = getAiConfig();
    if (!aiConfig) {
      return sendJson(res, 500, { error: 'API key تنظیم نشده' });
    }

    logEvent({
      type: 'chat_request',
      msg_count: messages.length,
      provider: aiConfig.provider,
      user_ip: req.socket.remoteAddress,
      ua: req.headers['user-agent']?.slice(0, 80)
    });

    const data = await callAi({ messages, system });

    logEvent({
      type: 'chat_success',
      provider: data.provider,
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0
    });

    sendJson(res, 200, { content: data.content });
  } catch (err) {
    const status = err.status || 500;
    logEvent({
      type: status >= 500 ? 'server_error' : 'api_error',
      status,
      error: err.message
    });
    console.error('API Error:', err);
    sendJson(res, status, {
      error: status >= 500 ? 'خطای سرور داخلی: ' + err.message : err.message
    });
  }
}

function handleAnalytics(req, res, url) {
  const secret = url.searchParams.get('secret');
  if (!secret || secret !== process.env.ANALYTICS_SECRET) {
    return sendJson(res, 403, { error: 'دسترسی ممنوع' });
  }

  try {
    if (!fs.existsSync(LOG_FILE)) {
      return sendJson(res, 200, { events: [] });
    }

    const lines = fs.readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));

    sendJson(res, 200, {
      total_requests: lines.filter(e => e.type === 'chat_request').length,
      total_success: lines.filter(e => e.type === 'chat_success').length,
      total_errors: lines.filter(e => e.type === 'api_error' || e.type === 'server_error').length,
      total_input_tokens: lines.reduce((a, e) => a + (e.input_tokens || 0), 0),
      total_output_tokens: lines.reduce((a, e) => a + (e.output_tokens || 0), 0),
      recent: lines.slice(-20)
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

function serveStatic(req, res, url) {
  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === '/') requestedPath = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  const finalPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(PUBLIC_DIR, 'index.html');

  const ext = path.extname(finalPath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.ico': 'image/x-icon'
  };

  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    ...corsHeaders()
  });
  fs.createReadStream(finalPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    return handleChat(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/analytics') {
    return handleAnalytics(req, res, url);
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const aiConfig = getAiConfig();
    return sendJson(res, 200, {
      status: 'ok',
      version: '1.0',
      provider: aiConfig?.provider || null,
      hasKey: !!aiConfig,
      uptime: Math.floor(process.uptime()) + 's'
    });
  }

  if (req.method === 'GET') {
    return serveStatic(req, res, url);
  }

  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, () => {
  const aiConfig = getAiConfig();
  console.log(`\nDecoBot is running on port ${PORT}`);
  console.log(`http://localhost:${PORT}\n`);

  if (!aiConfig) {
    console.warn('Warning: no AI API key configured.');
    console.warn('Create .env or KEY-API.env and add your API settings.\n');
  } else {
    console.log(`AI Provider: ${aiConfig.provider}`);
  }
});
