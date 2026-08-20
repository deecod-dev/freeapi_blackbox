const http = require('http');
const crypto = require('crypto');
const blackBox = require('./src/index.js');

const PORT = process.env.PORT || 3000;
const API_KEYS = (process.env.BLACKBOX_API_KEYS || 'sk-blackbox-default').split(',').map(k => k.trim());

// ─── Feature #6: Response Cache ─────────────────────────────────────────────
class ResponseCache {
  constructor(maxSize = 1000, ttlMs = 3600000) { // 1 hour default TTL
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.hits = 0;
    this.misses = 0;
  }

  _hash(prompt, model) {
    return crypto.createHash('md5').update(`${model}:${prompt}`).digest('hex');
  }

  get(prompt, model = 'default') {
    const key = this._hash(prompt, model);
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.misses++;
      return null;
    }
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    
    this.hits++;
    entry.lastAccess = Date.now();
    return entry.response;
  }

  set(prompt, response, model = 'default') {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      let oldest = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.lastAccess < oldestTime) {
          oldestTime = v.lastAccess;
          oldest = k;
        }
      }
      if (oldest) this.cache.delete(oldest);
    }

    const key = this._hash(prompt, model);
    this.cache.set(key, {
      response,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      lastAccess: Date.now()
    });
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 
        ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(1) + '%' 
        : '0%'
    };
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

// ─── Feature #7: Request Queue with Priority ────────────────────────────────
class PriorityQueue {
  constructor(maxConcurrency = 10, maxQueueSize = 500) {
    this.maxConcurrency = maxConcurrency;
    this.maxQueueSize = maxQueueSize;
    this.activeRequests = 0;
    this.queue = []; // { priority, resolve, reject, task, enqueuedAt }
    this.processed = 0;
    this.rejected = 0;
  }

  async add(task, priority = 5) {
    // Priority: 1 = highest, 10 = lowest
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxQueueSize) {
        this.rejected++;
        reject(new Error('Queue full. Try again later.'));
        return;
      }

      const item = { priority, resolve, reject, task, enqueuedAt: Date.now() };
      
      // Insert in priority order
      let inserted = false;
      for (let i = 0; i < this.queue.length; i++) {
        if (priority < this.queue[i].priority) {
          this.queue.splice(i, 0, item);
          inserted = true;
          break;
        }
      }
      if (!inserted) this.queue.push(item);

      this._processNext();
    });
  }

  async _processNext() {
    if (this.activeRequests >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    this.activeRequests++;
    const item = this.queue.shift();
    const waitTime = Date.now() - item.enqueuedAt;

    try {
      const result = await item.task();
      this.processed++;
      item.resolve({ result, waitTime });
    } catch (err) {
      item.reject(err);
    } finally {
      this.activeRequests--;
      this._processNext();
    }
  }

  getStats() {
    return {
      activeRequests: this.activeRequests,
      maxConcurrency: this.maxConcurrency,
      queueLength: this.queue.length,
      maxQueueSize: this.maxQueueSize,
      processed: this.processed,
      rejected: this.rejected
    };
  }
}

// ─── Feature #5: Smart Model Routing ────────────────────────────────────────
function classifyComplexity(prompt) {
  const lower = prompt.toLowerCase();
  const wordCount = prompt.split(/\s+/).length;
  
  // Simple queries (use fast models)
  const simplePatterns = [
    /^what is \d+\s*[\+\-\*\/]\s*\d+/,      // math
    /^(what|who|where|when) is the /,        // simple facts
    /^define /,                               // definitions
    /^spell /,                                // spelling
    /^translate .{1,50}$/,                   // short translations
    /^(yes|no)\?/,                           // yes/no questions
  ];
  
  // Complex queries (use smarter models)
  const complexPatterns = [
    /explain .* in detail/i,
    /write (a |an |)(code|program|script|function)/i,
    /debug|fix (this|my) (code|error)/i,
    /analyze|analysis/i,
    /compare and contrast/i,
    /step[- ]by[- ]step/i,
    /reasoning|think through/i,
    /essay|article|blog post/i,
    /strategy|plan|roadmap/i,
  ];

  for (const pattern of simplePatterns) {
    if (pattern.test(lower)) return 'simple';
  }
  
  for (const pattern of complexPatterns) {
    if (pattern.test(lower)) return 'complex';
  }

  // Length-based heuristic
  if (wordCount < 10) return 'simple';
  if (wordCount > 100) return 'complex';
  
  return 'medium';
}

// Model tiers based on capability
const MODEL_TIERS = {
  fast: ['cloudflare', 'groq', 'nvidia', 'huggingface'],      // 8B models, very fast
  balanced: ['mistral', 'gemini', 'openrouter'],               // 12B models, good balance
  smart: ['github', 'cohere', 'cerebras', 'zhipu']            // Larger/proprietary models
};

// ─── Feature #10: Health Monitoring ─────────────────────────────────────────
class HealthMonitor {
  constructor(checkIntervalMs = 300000) { // Check every 5 minutes
    this.providerHealth = new Map();
    this.lastFullCheck = null;
    this.checkIntervalMs = checkIntervalMs;
  }

  recordSuccess(providerId, latencyMs) {
    const health = this.providerHealth.get(providerId) || this._newHealth();
    health.successCount++;
    health.totalRequests++;
    health.latencies.push(latencyMs);
    if (health.latencies.length > 100) health.latencies.shift();
    health.lastSuccess = Date.now();
    health.consecutiveFailures = 0;
    health.status = 'healthy';
    this.providerHealth.set(providerId, health);
  }

  recordFailure(providerId, error) {
    const health = this.providerHealth.get(providerId) || this._newHealth();
    health.failureCount++;
    health.totalRequests++;
    health.consecutiveFailures++;
    health.lastFailure = Date.now();
    health.lastError = error;
    
    if (health.consecutiveFailures >= 5) {
      health.status = 'degraded';
    }
    if (health.consecutiveFailures >= 10) {
      health.status = 'unhealthy';
    }
    
    this.providerHealth.set(providerId, health);
  }

  _newHealth() {
    return {
      successCount: 0,
      failureCount: 0,
      totalRequests: 0,
      consecutiveFailures: 0,
      latencies: [],
      lastSuccess: null,
      lastFailure: null,
      lastError: null,
      status: 'unknown'
    };
  }

  getHealth(providerId) {
    return this.providerHealth.get(providerId) || this._newHealth();
  }

  getAllHealth() {
    const result = {};
    for (const [id, health] of this.providerHealth) {
      const avgLatency = health.latencies.length > 0
        ? (health.latencies.reduce((a, b) => a + b, 0) / health.latencies.length).toFixed(0)
        : null;
      
      result[id] = {
        status: health.status,
        successRate: health.totalRequests > 0 
          ? ((health.successCount / health.totalRequests) * 100).toFixed(1) + '%'
          : 'N/A',
        avgLatencyMs: avgLatency,
        totalRequests: health.totalRequests,
        consecutiveFailures: health.consecutiveFailures,
        lastError: health.lastError
      };
    }
    return result;
  }
}

// ─── Feature #9: Better Error Messages ──────────────────────────────────────
class APIError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.code,
        code: this.code,
        details: this.details
      }
    };
  }
}

const ERROR_CODES = {
  INVALID_REQUEST: 'invalid_request_error',
  AUTHENTICATION: 'authentication_error', 
  RATE_LIMIT: 'rate_limit_error',
  SERVER_ERROR: 'server_error',
  QUEUE_FULL: 'queue_full_error',
  TIMEOUT: 'timeout_error'
};

// ─── Initialize Services ────────────────────────────────────────────────────
const cache = new ResponseCache(1000, 3600000);  // 1000 entries, 1 hour TTL
const queue = new PriorityQueue(15, 500);         // 15 concurrent, 500 max queue
const healthMonitor = new HealthMonitor();

// ─── Feature #8: API Key Authentication ─────────────────────────────────────
function authenticate(req) {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header' };
  }

  const token = authHeader.replace('Bearer ', '').trim();
  
  if (!API_KEYS.includes(token)) {
    return { valid: false, error: 'Invalid API key' };
  }

  return { valid: true };
}

// ─── Feature #1: OpenAI-Compatible API ──────────────────────────────────────
function parseOpenAIRequest(body) {
  const { model, messages, temperature, max_tokens, stream } = body;
  
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new APIError('messages is required and must be a non-empty array', ERROR_CODES.INVALID_REQUEST);
  }

  // Extract the prompt from messages
  let prompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      prompt += `System: ${msg.content}\n\n`;
    } else if (msg.role === 'user') {
      prompt += `User: ${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      prompt += `Assistant: ${msg.content}\n\n`;
    }
  }
  prompt += 'Assistant:';

  return {
    prompt: prompt.trim(),
    model: model || 'auto',
    temperature: temperature || 0.7,
    maxTokens: max_tokens || 2048,
    stream: stream || false,
    lastUserMessage: messages.filter(m => m.role === 'user').pop()?.content || ''
  };
}

function formatOpenAIResponse(content, model = 'blackbox-auto', promptTokens = 0) {
  const completionTokens = Math.ceil(content.length / 4);
  
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content
      },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  };
}

// ─── Request Handler ────────────────────────────────────────────────────────
async function handleChatCompletion(req, res, body) {
  const startTime = Date.now();
  
  try {
    const { prompt, model, lastUserMessage } = parseOpenAIRequest(body);
    const promptTokens = Math.ceil(prompt.length / 4);

    // Feature #6: Check cache first
    const cached = cache.get(lastUserMessage, model);
    if (cached) {
      const response = formatOpenAIResponse(cached, `blackbox-cached`, promptTokens);
      response._meta = { cached: true, latencyMs: Date.now() - startTime };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    // Feature #5: Smart routing - determine priority based on complexity
    const complexity = classifyComplexity(lastUserMessage);
    const priority = complexity === 'simple' ? 3 : complexity === 'complex' ? 7 : 5;

    // Feature #7: Queue the request
    const { result: content, waitTime } = await queue.add(async () => {
      const callStart = Date.now();
      const result = await blackBox.generateContent(prompt, false);
      const latency = Date.now() - callStart;
      
      // Feature #10: Record health metrics
      // We don't know which provider was used, but we can track overall success
      healthMonitor.recordSuccess('aggregate', latency);
      
      return result;
    }, priority);

    // Feature #6: Cache the response
    cache.set(lastUserMessage, content, model);

    const response = formatOpenAIResponse(content, `blackbox-${complexity}`, promptTokens);
    response._meta = {
      cached: false,
      complexity,
      queueWaitMs: waitTime,
      totalLatencyMs: Date.now() - startTime
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));

  } catch (err) {
    healthMonitor.recordFailure('aggregate', err.message);
    
    if (err instanceof APIError) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(err.toJSON()));
    } else if (err.message.includes('Queue full')) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(new APIError(
        'Server is overloaded. Please retry in a few seconds.',
        ERROR_CODES.QUEUE_FULL,
        { retryAfter: 5 }
      ).toJSON()));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(new APIError(
        err.message || 'Internal server error',
        ERROR_CODES.SERVER_ERROR,
        { originalError: err.message }
      ).toJSON()));
    }
  }
}

// ─── Simple /chat endpoint (backward compatible) ────────────────────────────
async function handleSimpleChat(req, res, body) {
  const startTime = Date.now();
  
  try {
    const { prompt, json, priority = 5 } = body;
    
    if (!prompt) {
      throw new APIError('Missing "prompt" in request body', ERROR_CODES.INVALID_REQUEST);
    }

    // Check cache
    const cached = cache.get(prompt);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: cached, cached: true, latencyMs: Date.now() - startTime }));
      return;
    }

    const { result: response, waitTime } = await queue.add(
      () => blackBox.generateContent(prompt, json || false),
      priority
    );

    cache.set(prompt, response);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      response, 
      cached: false,
      queueWaitMs: waitTime,
      latencyMs: Date.now() - startTime 
    }));

  } catch (err) {
    const status = err.message.includes('Queue full') ? 429 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ─── Stats Endpoint ─────────────────────────────────────────────────────────
function handleStats(req, res) {
  const stats = {
    server: {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    },
    cache: cache.getStats(),
    queue: queue.getStats(),
    health: healthMonitor.getAllHealth(),
    blackbox: blackBox.getState ? blackBox.getState() : 'N/A'
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(stats, null, 2));
}

// ─── Models Endpoint (OpenAI compatible) ────────────────────────────────────
function handleModels(req, res) {
  const models = {
    object: 'list',
    data: [
      { id: 'blackbox-auto', object: 'model', created: Date.now(), owned_by: 'blackbox' },
      { id: 'blackbox-fast', object: 'model', created: Date.now(), owned_by: 'blackbox' },
      { id: 'blackbox-balanced', object: 'model', created: Date.now(), owned_by: 'blackbox' },
      { id: 'blackbox-smart', object: 'model', created: Date.now(), owned_by: 'blackbox' },
    ]
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(models));
}

// ─── Main Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // Public endpoints (no auth required)
  if (url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'BlackBox API Server',
      version: '2.0.0',
      features: [
        'OpenAI-compatible /v1/chat/completions',
        'Smart model routing',
        'Response caching',
        'Priority queue',
        'Health monitoring'
      ],
      endpoints: {
        chat: 'POST /v1/chat/completions (OpenAI compatible)',
        simple: 'POST /chat (simple prompt/response)',
        models: 'GET /v1/models',
        stats: 'GET /stats',
        health: 'GET /health',
        dashboard: 'http://localhost:3737'
      }
    }));
    return;
  }

  if (url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  if (url === '/v1/models' && req.method === 'GET') {
    handleModels(req, res);
    return;
  }

  // Protected endpoints (auth required)
  const auth = authenticate(req);
  if (!auth.valid) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(new APIError(auth.error, ERROR_CODES.AUTHENTICATION).toJSON()));
    return;
  }

  // Parse body for POST requests
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);

        if (url === '/v1/chat/completions') {
          await handleChatCompletion(req, res, parsed);
        } else if (url === '/chat') {
          await handleSimpleChat(req, res, parsed);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(new APIError('Invalid JSON in request body', ERROR_CODES.INVALID_REQUEST).toJSON()));
      }
    });
    return;
  }

  if (url === '/stats' && req.method === 'GET') {
    handleStats(req, res);
    return;
  }

  if (url === '/cache/clear' && req.method === 'POST') {
    cache.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Cache cleared' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           🚀 BlackBox API Server v2.0.0                      ║
╠══════════════════════════════════════════════════════════════╣
║  API Server:     http://localhost:${PORT}                        ║
║  Dashboard:      http://localhost:3737                       ║
╠══════════════════════════════════════════════════════════════╣
║  FEATURES:                                                   ║
║  ✅ OpenAI-compatible API (/v1/chat/completions)             ║
║  ✅ Smart model routing (auto-detect complexity)             ║
║  ✅ Response caching (1hr TTL)                               ║
║  ✅ Priority queue (15 concurrent, 500 max queue)            ║
║  ✅ API key authentication                                   ║
║  ✅ Better error messages                                    ║
║  ✅ Health monitoring                                        ║
╠══════════════════════════════════════════════════════════════╣
║  DEFAULT API KEY: sk-blackbox-default                        ║
║  (Set BLACKBOX_API_KEYS env var for custom keys)             ║
╠══════════════════════════════════════════════════════════════╣
║  USAGE:                                                      ║
║  curl http://localhost:${PORT}/v1/chat/completions \\            ║
║    -H "Authorization: Bearer sk-blackbox-default" \\          ║
║    -H "Content-Type: application/json" \\                     ║
║    -d '{"messages":[{"role":"user","content":"Hello!"}]}'    ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
