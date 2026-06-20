const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const delay = ms => new Promise(res => setTimeout(res, ms));

// ─── Paths ──────────────────────────────────────────────────────────────────
const DEAD_KEYS_PATH = path.join(__dirname, '../data/dead_keys.json');
const DASHBOARD_HTML = path.join(__dirname, 'dashboard.html');
const DASHBOARD_PORT = 3737;

// ─── Provider Registry ──────────────────────────────────────────────────────
// Ordered by speed (fastest drop rate first). The router always picks the
// fastest bucket that has a token available.
//
// dropRateMs = exact milliseconds between allowed requests (60000 / RPM).
// supportsJsonMode = whether the provider's model handles response_format.
// extraHeaders = provider-specific headers required for auth or routing.

const PROVIDERS = [
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    dropRateMs: 40,           // 1500 RPM
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    isGoogle: false,
    isCloudflare: true,
    envKey: 'CLOUDFLARE_API_TOKEN',
    envAccountId: 'CLOUDFLARE_ACCOUNT_ID',
    supportsJsonMode: false,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    dropRateMs: 1000,         // 60 RPM
    model: 'open-mistral-nemo',
    isGoogle: false,
    envKey: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    supportsJsonMode: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    dropRateMs: 2000,         // 30 RPM
    model: 'llama-3.3-70b-versatile',
    isGoogle: false,
    envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    supportsJsonMode: true,
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    dropRateMs: 2000,         // 30 RPM
    model: 'gpt-oss-120b',
    isGoogle: false,
    envKey: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
    supportsJsonMode: false,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    dropRateMs: 3000,         // 20 RPM
    model: 'mistralai/mistral-nemo',
    isGoogle: false,
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    supportsJsonMode: false,
    extraHeaders: {
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'JobApplier',
    },
  },
  {
    id: 'github',
    name: 'GitHub Models',
    dropRateMs: 4000,         // 15 RPM
    model: 'gpt-4o-mini',
    isGoogle: false,
    envKey: 'GITHUB_TOKEN',
    baseUrl: 'https://models.github.ai/inference',
    supportsJsonMode: true,
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI',
    dropRateMs: 4000,         // 15 RPM
    model: 'glm-4-flash',
    isGoogle: false,
    envKey: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    supportsJsonMode: false,
  },
  {
    id: 'cohere',
    name: 'Cohere',
    dropRateMs: 6000,         // 10 RPM
    model: 'command-r-plus-08-2024',
    isGoogle: false,
    envKey: 'COHERE_API_KEY',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    supportsJsonMode: false,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    dropRateMs: 6000,         // 10 RPM
    model: 'meta/llama-3.1-8b-instruct',
    isGoogle: false,
    envKey: 'NVIDIA_API_KEY',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    supportsJsonMode: false,
  },
  {
    id: 'huggingface',
    name: 'HuggingFace',
    dropRateMs: 6000,         // 10 RPM
    model: 'meta-llama/Meta-Llama-3-8B-Instruct',
    isGoogle: false,
    envKey: 'HF_TOKEN',
    baseUrl: 'https://router.huggingface.co/v1',
    supportsJsonMode: false,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    dropRateMs: 12000,        // 5 RPM
    model: 'gemini-flash-latest',
    isGoogle: true,
    envKey: 'GEMINI_API_KEY',
    supportsJsonMode: true,
  },
];

// ─── Penalty tiers ──────────────────────────────────────────────────────────
const PENALTY = {
  TRANSIENT:  60_000,        // 429 "retry in Xs" → bench 60s
  DAILY:      3_600_000,     // daily quota hit → bench 1 hour
  DEAD_KEY:   86_400_000,    // 401/403 → bench 24 hours (key is dead)
};

const MAX_TOTAL_RETRIES = 30;

// ─── BlackBoxRouter ─────────────────────────────────────────────────────────
class BlackBoxRouter {
  constructor() {
    this.buckets = [];
    this.deadProviders = [];      // providers killed during this session
    this.persistedDeadKeys = [];  // loaded from disk
    this.sseClients = [];
    this.startedAt = Date.now();

    this.queueStats = { total: 0, pending: 0, done: 0 };
    this.jobStats = { accepted: 0, rejected: 0, email: 0, external: 0, easyApply: 0, others: 0 };
    this.currentTag = 'Initializing...';

    this.stats = {
      totalRequests: 0,
      successCount: 0,
      failCount: 0,
    };

    this._loadDeadKeys();
    this._initProviders();
    this._startDashboardServer();
    this._startStatsBroadcast();
  }

  // ── Dead key persistence ────────────────────────────────────────────────
  _loadDeadKeys() {
    try {
      if (fs.existsSync(DEAD_KEYS_PATH)) {
        this.persistedDeadKeys = JSON.parse(fs.readFileSync(DEAD_KEYS_PATH, 'utf8'));
        if (this.persistedDeadKeys.length > 0) {
          console.log(`[BlackBox] 🗃️  Loaded ${this.persistedDeadKeys.length} dead key(s) from disk.`);
        }
      }
    } catch {
      this.persistedDeadKeys = [];
    }
  }

  _isPersistedDead(providerId, apiKey) {
    const prefix = apiKey.substring(0, 12);
    return this.persistedDeadKeys.some(
      d => d.id === providerId && d.keyPrefix === prefix
    );
  }

  _persistDeadKey(providerId, apiKey, reason) {
    const entry = {
      id: providerId,
      keyPrefix: apiKey.substring(0, 12),
      reason,
      killedAt: new Date().toISOString(),
    };
    this.persistedDeadKeys.push(entry);
    try {
      fs.mkdirSync(path.dirname(DEAD_KEYS_PATH), { recursive: true });
      fs.writeFileSync(DEAD_KEYS_PATH, JSON.stringify(this.persistedDeadKeys, null, 2));
    } catch (e) {
      console.error(`[BlackBox] Could not save dead key to disk:`, e.message);
    }
  }

  // ── Provider initialization ─────────────────────────────────────────────
  _initProviders() {
    for (const p of PROVIDERS) {
      const apiKey = process.env[p.envKey];
      if (!apiKey) continue;

      // Skip keys that are persisted as dead
      if (this._isPersistedDead(p.id, apiKey)) {
        console.log(`[BlackBox] 💀 Skipping ${p.name}: key is permanently dead (saved from previous run).`);
        this.deadProviders.push({
          config: p,
          reason: 'Dead key (from previous run)',
          killedAt: this.persistedDeadKeys.find(d => d.id === p.id)?.killedAt || 'unknown',
        });
        continue;
      }

      let client;

      if (p.isGoogle) {
        const genAI = new GoogleGenerativeAI(apiKey);
        client = genAI.getGenerativeModel({ model: p.model });
      } else if (p.isCloudflare) {
        const accountId = process.env[p.envAccountId];
        if (!accountId) {
          console.warn(`[BlackBox] Skipping Cloudflare: CLOUDFLARE_ACCOUNT_ID not set.`);
          continue;
        }
        client = new OpenAI({
          apiKey: apiKey,
          baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
          timeout: 20000,
        });
      } else {
        const opts = { apiKey, baseURL: p.baseUrl, timeout: 20000 };
        if (p.extraHeaders) opts.defaultHeaders = p.extraHeaders;
        client = new OpenAI(opts);
      }

      this.buckets.push({
        config: p,
        client,
        apiKey,                        // stored for dead-key matching
        nextAvailableMs: Date.now(),
        consecutiveFailures: 0,
        requestsDone: 0,
        requestsFailed: 0,
        lastError: null,
        status: 'ready',               // 'ready' | 'cooling' | 'benched' | 'dead'
      });

      console.log(`[BlackBox] ✅ Enabled: ${p.name} (${p.model}) — 1 req every ${p.dropRateMs}ms`);
    }

    if (this.buckets.length === 0) {
      console.error('[BlackBox] FATAL: No API keys found in .env!');
      console.error('[BlackBox] Add at least one of: GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, etc.');
      process.exit(1);
    }

    console.log(`[BlackBox] Router online with ${this.buckets.length} provider(s).\n`);
  }

  updateQueue(total, pending, done) {
    this.queueStats = { total, pending, done };
  }

  updateJobStats(stats) {
    this.jobStats = { ...this.jobStats, ...stats };
  }

  // ── Getters ─────────────────────────────────────────────────────────────
  get providerCount() {
    return this.buckets.filter(b => b.status !== 'dead').length;
  }

  get totalRPM() {
    return this.buckets
      .filter(b => b.status !== 'dead')
      .reduce((sum, b) => sum + Math.floor(60000 / b.config.dropRateMs), 0);
  }

  // ── State snapshot for dashboard ────────────────────────────────────────
  getState() {
    const now = Date.now();

    const providers = this.buckets.map(b => {
      const cooldownMs = Math.max(0, b.nextAvailableMs - now);
      let status = b.status;
      if (status !== 'dead') {
        if (cooldownMs <= 0) status = 'ready';
        else if (cooldownMs > 60000) status = 'benched';
        else status = 'cooling';
      }

      return {
        id: b.config.id,
        name: b.config.name,
        model: b.config.model,
        rpm: Math.floor(60000 / b.config.dropRateMs),
        status,
        cooldownMs,
        cooldownSec: (cooldownMs / 1000).toFixed(1),
        requestsDone: b.requestsDone,
        requestsFailed: b.requestsFailed,
        consecutiveFailures: b.consecutiveFailures,
        lastError: b.lastError,
      };
    });

    // Sort: least cooldown first. If equal (e.g., both 0 for ready), sort by most done.
    providers.sort((a, b) => {
      if (a.status === 'dead' && b.status !== 'dead') return 1;
      if (b.status === 'dead' && a.status !== 'dead') return -1;
      
      if (a.cooldownMs !== b.cooldownMs) {
        return a.cooldownMs - b.cooldownMs;
      }
      return b.requestsDone - a.requestsDone;
    });

    const dead = this.deadProviders.map(d => ({
      id: d.config.id,
      name: d.config.name,
      model: d.config.model,
      reason: d.reason,
      killedAt: d.killedAt,
    }));

    return {
      providers,
      dead,
      queueStats: this.queueStats,
      jobStats: this.jobStats,
      workerStates: this.workerStates || [],
      currentTag: this.currentTag,
      stats: {
        ...this.stats,
        activeProviders: this.buckets.filter(b => b.status !== 'dead').length,
        deadProviders: this.deadProviders.length + this.buckets.filter(b => b.status === 'dead').length,
        uptimeSeconds: Math.floor((now - this.startedAt) / 1000),
        currentRPM: this.totalRPM,
      },
    };
  }

  // ── Dashboard HTTP + SSE server ─────────────────────────────────────────
  _startDashboardServer() {
    const server = http.createServer((req, res) => {
      if (req.url === '/events') {
        // SSE endpoint
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write('data: ' + JSON.stringify(this.getState()) + '\n\n');
        this.sseClients.push(res);
        req.on('close', () => {
          this.sseClients = this.sseClients.filter(c => c !== res);
        });
      } else if (req.url === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getState(), null, 2));
      } else {
        // Serve dashboard HTML
        try {
          const html = fs.readFileSync(DASHBOARD_HTML, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } catch (e) {
          res.writeHead(500);
          res.end('Dashboard HTML not found: ' + e.message);
        }
      }
    });

    server.listen(DASHBOARD_PORT, () => {
      console.log(`[BlackBox] 📊 Dashboard live at http://localhost:${DASHBOARD_PORT}\n`);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[BlackBox] ⚠️  Dashboard port ${DASHBOARD_PORT} in use, skipping.`);
      }
    });
  }

  _startStatsBroadcast() {
    setInterval(() => {
      if (this.sseClients.length === 0) return;
      const data = 'data: ' + JSON.stringify(this.getState()) + '\n\n';
      for (const client of this.sseClients) {
        try { client.write(data); } catch { /* client disconnected */ }
      }
    }, 500);
  }

  // ── Kill a bucket permanently ───────────────────────────────────────────
  _killBucket(bucket, reason) {
    bucket.status = 'dead';
    bucket.nextAvailableMs = Infinity;

    this.deadProviders.push({
      config: bucket.config,
      reason,
      killedAt: new Date().toISOString(),
    });

    // Persist to disk so it's never used again
    this._persistDeadKey(bucket.config.id, bucket.apiKey, reason);
  }

  // ── Core routing method ─────────────────────────────────────────────────
  async generateContent(prompt, requireJson = false) {
    let totalRetries = 0;
    this.stats.totalRequests++;

    while (totalRetries < MAX_TOTAL_RETRIES) {
      const now = Date.now();
      let bestBucket = null;
      let minWaitMs = Infinity;

      // 1. Find the fastest available bucket
      for (const bucket of this.buckets) {
        if (bucket.status === 'dead') continue;

        const wait = bucket.nextAvailableMs - now;
        if (wait <= 0) {
          if (!bestBucket || bucket.config.dropRateMs < bestBucket.config.dropRateMs) {
            bestBucket = bucket;
          }
        } else if (wait < minWaitMs) {
          minWaitMs = wait;
        }
      }

      // 2. No buckets free → micro-sleep until the next one opens
      if (!bestBucket) {
        if (minWaitMs === Infinity) {
          this.stats.failCount++;
          throw new Error('[BlackBox] All providers are exhausted or have dead keys. Cannot process.');
        }
        
        // Prevent spamming the console if 10 workers sleep at the exact same time
        if (!this._lastSleepLog || Date.now() - this._lastSleepLog > 2000) {
          console.log(`\n[BlackBox] 💤 All providers currently hit their rate limits. Auto-sleeping for ${Math.round(minWaitMs/1000)}s to prevent crashing...`);
          this._lastSleepLog = Date.now();
        }
        
        await delay(minWaitMs);
        continue;
      }

      // 3. Consume the token BEFORE the API call
      bestBucket.nextAvailableMs = Date.now() + bestBucket.config.dropRateMs;

      const providerName = bestBucket.config.name;
      console.log(`[BlackBox] → ${providerName} (${bestBucket.config.model})`);

      try {
        let result;

        const apiCallPromise = (async () => {
          if (bestBucket.config.isGoogle) {
            const genConfig = requireJson ? { responseMimeType: 'application/json' } : {};
            const res = await bestBucket.client.generateContent({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: genConfig,
            });
            return res.response.text();
          } else {
            const messages = [{ role: 'user', content: prompt }];
            const params = { model: bestBucket.config.model, messages };

            if (requireJson && bestBucket.config.supportsJsonMode) {
              params.response_format = { type: 'json_object' };
            }

            const res = await bestBucket.client.chat.completions.create(params);
            return res.choices[0].message.content;
          }
        })();

        // Hard timeout to prevent permanent socket hangs (25s)
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('API Socket Timeout (25s)')), 25000);
        });

        try {
          result = await Promise.race([apiCallPromise, timeoutPromise]);
        } finally {
          clearTimeout(timeoutId);
        }

        // Success!
        bestBucket.consecutiveFailures = 0;
        bestBucket.requestsDone++;
        bestBucket.status = 'cooling';
        bestBucket.lastError = null;
        this.stats.successCount++;
        return result;

      } catch (error) {
        totalRetries++;
        const errMsg = (error && error.message) ? error.message.substring(0, 120) : String(error);
        const status = error.status || error.statusCode || 0;

        bestBucket.requestsFailed++;
        bestBucket.lastError = errMsg;

        // ── Smart penalty ──
        if (status === 401 || status === 403) {
          console.error(`[BlackBox] ☠️  ${providerName} — DEAD KEY (${status}). Permanently killed.`);
          this._killBucket(bestBucket, `${status} ${errMsg}`);
        } else if (status === 429 && /daily|day|TPD/i.test(errMsg)) {
          bestBucket.nextAvailableMs = Date.now() + PENALTY.DAILY;
          bestBucket.status = 'benched';
          console.error(`[BlackBox] 🛑 ${providerName} — Daily quota hit. Benching for 1h.`);
        } else {
          bestBucket.nextAvailableMs = Date.now() + PENALTY.TRANSIENT;
          bestBucket.status = 'cooling';
          console.error(`[BlackBox] ⚠️  ${providerName} — ${errMsg}. Benching for 60s.`);
        }

        bestBucket.consecutiveFailures++;
      }
    }

    this.stats.failCount++;
    throw new Error(`[BlackBox] Exhausted ${MAX_TOTAL_RETRIES} retries across all providers.`);
  }
}

// ── Singleton export ────────────────────────────────────────────────────────
const blackBox = new BlackBoxRouter();
module.exports = blackBox;
