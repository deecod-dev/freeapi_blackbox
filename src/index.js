const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const delay = ms => new Promise(res => setTimeout(res, ms));

// ─── Paths ──────────────────────────────────────────────────────────────────
const DEAD_KEYS_PATH = path.join(__dirname, '../data/dead_keys.json');
const STATE_DIR = path.join(__dirname, '../data/provider_state');
const DASHBOARD_HTML = path.join(__dirname, 'dashboard.html');
const DASHBOARD_PORT = 3737;

// ─── Helpers ────────────────────────────────────────────────────────────────
function estimateTokens(prompt) {
  return Math.ceil(prompt.length / 4);
}

function parseResetTime(str) {
  // parses "1s", "30s", "2m30s", "1m", "500ms" into milliseconds
  if (!str) return 60000;
  let ms = 0;
  const mMatch = str.match(/(\d+)m(?!s)/);
  const sMatch = str.match(/(\d+)s/);
  const msMatch = str.match(/(\d+)ms/);
  if (mMatch) ms += parseInt(mMatch[1]) * 60000;
  if (sMatch) ms += parseInt(sMatch[1]) * 1000;
  if (msMatch) ms += parseInt(msMatch[1]);
  return ms || 60000;
}

function getTodayStr() { return new Date().toISOString().slice(0, 10); }
function getMonthStr() { return new Date().toISOString().slice(0, 7); }

// ─── Provider Registry (Verified June 2026) ─────────────────────────────────
// Every limit is sourced from official docs. Comments cite the source.

const PROVIDERS = [
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    model: '@cf/meta/llama-3.1-8b-instruct-fast',
    isGoogle: false,
    isCloudflare: true,
    envKey: 'CLOUDFLARE_API_TOKEN',
    envAccountId: 'CLOUDFLARE_ACCOUNT_ID',
    supportsJsonMode: false,
    limits: {
      rpm: 300,                    // developers.cloudflare.com/workers-ai/platform/limits — Text Generation default
      tpm: null,
      rpd: null,
      monthlyBudget: null,
      dailyNeurons: 10000,         // 10k neurons/day free (developers.cloudflare.com/workers-ai/platform/pricing)
      neuronCostPerRequest: 10,    // ~10 neurons avg (4119 in + 34868 out per M tokens, ~800in/200out per req)
      maxConcurrency: 10,
    },
  },
  {
    id: 'mistral',
    name: 'Mistral',
    model: 'open-mistral-nemo',
    isGoogle: false,
    envKey: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    supportsJsonMode: true,
    limits: {
      rpm: 60,                     // 1 RPS strict (console.mistral.ai)
      tpm: 500000,
      rpd: null,
      monthlyBudget: null,
      maxConcurrency: 1,
    },
  },
  {
    id: 'groq',
    name: 'Groq',
    model: 'llama-3.3-70b-versatile',
    isGoogle: false,
    envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    supportsJsonMode: true,
    limits: {
      rpm: 30,
      tpm: 6000,                   // tiny for 70B — the TPM trap
      rpd: 14400,
      monthlyBudget: null,
      maxConcurrency: 2,
    },
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    model: 'gpt-oss-120b',
    isGoogle: false,
    envKey: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
    supportsJsonMode: false,
    limits: {
      rpm: 5,                      // free trial = 5 RPM (was wrongly 30)
      tpm: 30000,
      rpd: null,
      monthlyBudget: null,
      maxConcurrency: 1,
    },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    model: 'mistralai/mistral-nemo',
    isGoogle: false,
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    supportsJsonMode: false,
    extraHeaders: {
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'BlackBox',
    },
    limits: {
      rpm: 20,
      tpm: null,
      rpd: 50,                     // 50 RPD at $0 balance
      monthlyBudget: null,
      maxConcurrency: 5,
    },
  },
  {
    id: 'github',
    name: 'GitHub Models',
    model: 'gpt-4o-mini',
    isGoogle: false,
    envKey: 'GITHUB_TOKEN',
    baseUrl: 'https://models.github.ai/inference',
    supportsJsonMode: true,
    limits: {
      rpm: 15,
      tpm: null,
      rpd: 150,
      monthlyBudget: null,
      maxConcurrency: 2,
    },
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI',
    model: 'glm-4-flash',
    isGoogle: false,
    envKey: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    supportsJsonMode: false,
    limits: {
      rpm: null,                   // no RPM limit — concurrency-gated instead
      tpm: null,
      rpd: null,
      monthlyBudget: null,
      maxConcurrency: 1,           // 1 concurrent on free tier
    },
  },
  {
    id: 'cohere',
    name: 'Cohere',
    model: 'command-r-plus-08-2024',
    isGoogle: false,
    envKey: 'COHERE_API_KEY',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    supportsJsonMode: false,
    limits: {
      rpm: 20,
      tpm: null,
      rpd: null,
      monthlyBudget: 1000,         // 1,000 calls/month on trial key
      maxConcurrency: 5,
    },
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    model: 'meta/llama-3.1-8b-instruct',
    isGoogle: false,
    envKey: 'NVIDIA_API_KEY',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    supportsJsonMode: false,
    limits: {
      rpm: 40,                     // was wrongly 10 — 4x underutilized
      tpm: null,
      rpd: null,
      monthlyBudget: null,
      maxConcurrency: 5,
    },
  },
  {
    id: 'huggingface',
    name: 'HuggingFace',
    model: 'meta-llama/Meta-Llama-3-8B-Instruct',
    isGoogle: false,
    envKey: 'HF_TOKEN',
    baseUrl: 'https://router.huggingface.co/v1',
    supportsJsonMode: false,
    limits: {
      rpm: 10,                     // unofficial, conservative
      tpm: null,
      rpd: null,
      monthlyBudget: null,
      maxConcurrency: 1,
    },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    model: 'gemini-flash-latest',
    isGoogle: true,
    envKey: 'GEMINI_API_KEY',
    supportsJsonMode: true,
    limits: {
      rpm: 10,                     // was wrongly 5 — 2x underutilized
      tpm: 250000,
      rpd: 1500,
      monthlyBudget: null,
      maxConcurrency: 3,
    },
  },
];

const MAX_TOTAL_RETRIES = 30;

// ─── BlackBoxRouter v2 ──────────────────────────────────────────────────────
class BlackBoxRouter {
  constructor() {
    this.buckets = [];
    this.deadProviders = [];
    this.persistedDeadKeys = [];
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

    this._savePending = 0;
    this._lastSleepLog = 0;

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

  // ── Provider state persistence (daily/monthly counters) ─────────────────
  _loadProviderState(bucket) {
    const filePath = path.join(STATE_DIR, `${bucket.config.id}.json`);
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const today = getTodayStr();
        const thisMonth = getMonthStr();

        // reset daily counters if date changed
        if (data.lastResetDate === today) {
          bucket.dailyUsed = data.dailyUsed || 0;
          bucket.dailyNeuronsUsed = data.dailyNeuronsUsed || 0;
        }
        // reset monthly counters if month changed
        if (data.lastMonthlyResetMonth === thisMonth) {
          bucket.monthlyUsed = data.monthlyUsed || 0;
        }
        console.log(`[BlackBox]    ↳ State loaded: ${bucket.dailyUsed} daily, ${bucket.monthlyUsed} monthly`);
      }
    } catch { /* fresh start */ }
  }

  _saveProviderState(bucket) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const filePath = path.join(STATE_DIR, `${bucket.config.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify({
        dailyUsed: bucket.dailyUsed,
        dailyNeuronsUsed: bucket.dailyNeuronsUsed,
        monthlyUsed: bucket.monthlyUsed,
        lastResetDate: getTodayStr(),
        lastMonthlyResetMonth: getMonthStr(),
      }, null, 2));
    } catch (e) {
      console.error(`[BlackBox] Could not save provider state for ${bucket.config.id}:`, e.message);
    }
  }

  _debouncedSave(bucket) {
    bucket._saveCounter = (bucket._saveCounter || 0) + 1;
    if (bucket._saveCounter >= 5) {
      bucket._saveCounter = 0;
      this._saveProviderState(bucket);
    }
  }

  // ── Provider initialization ─────────────────────────────────────────────
  _initProviders() {
    for (const p of PROVIDERS) {
      const apiKey = process.env[p.envKey];
      if (!apiKey) continue;

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

      const lim = p.limits;
      const rpmMax = lim.rpm || Infinity;
      const refillMs = lim.rpm ? (60000 / lim.rpm) : 0;

      const bucket = {
        config: p,
        client,
        apiKey,

        // ── RPM token bucket ──
        rpmTokens: rpmMax,
        rpmMax: rpmMax,
        rpmRefillMs: refillMs,
        lastRpmRefill: Date.now(),

        // ── TPM tracking ──
        tpmUsed: 0,
        tpmLimit: lim.tpm || Infinity,
        tpmResetAt: Date.now() + 60000,

        // ── Daily tracking ──
        dailyUsed: 0,
        dailyLimit: lim.rpd || Infinity,
        dailyNeuronsUsed: 0,
        dailyNeuronsLimit: lim.dailyNeurons || Infinity,
        neuronCostPerRequest: lim.neuronCostPerRequest || 0,

        // ── Monthly tracking ──
        monthlyUsed: 0,
        monthlyLimit: lim.monthlyBudget || Infinity,

        // ── Concurrency ──
        activeRequests: 0,
        maxConcurrency: lim.maxConcurrency || 1,

        // ── Health ──
        consecutiveFailures: 0,
        requestsDone: 0,
        requestsFailed: 0,
        lastError: null,
        status: 'ready',
        nextForceWait: 0,          // server-told "wait until this ms"
        _saveCounter: 0,
      };

      this._loadProviderState(bucket);
      this.buckets.push(bucket);

      const rpmStr = lim.rpm ? `${lim.rpm} RPM` : 'concurrency-gated';
      const extras = [];
      if (lim.tpm) extras.push(`${lim.tpm} TPM`);
      if (lim.rpd) extras.push(`${lim.rpd} RPD`);
      if (lim.dailyNeurons) extras.push(`${lim.dailyNeurons} neurons/day`);
      if (lim.monthlyBudget) extras.push(`${lim.monthlyBudget}/month`);
      const extraStr = extras.length > 0 ? ` | ${extras.join(', ')}` : '';

      console.log(`[BlackBox] ✅ Enabled: ${p.name} (${p.model}) — ${rpmStr}${extraStr}`);
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

  // ── RPM token refill ───────────────────────────────────────────────────
  _refillTokens(bucket) {
    if (bucket.rpmRefillMs === 0) return; // no RPM limit (zhipu)
    const now = Date.now();
    const elapsed = now - bucket.lastRpmRefill;
    const tokensToAdd = Math.floor(elapsed / bucket.rpmRefillMs);
    if (tokensToAdd > 0) {
      bucket.rpmTokens = Math.min(bucket.rpmMax, bucket.rpmTokens + tokensToAdd);
      bucket.lastRpmRefill = now;
    }
  }

  // ── TPM reset ──────────────────────────────────────────────────────────
  _resetTpmIfNeeded(bucket) {
    const now = Date.now();
    if (now >= bucket.tpmResetAt) {
      bucket.tpmUsed = 0;
      bucket.tpmResetAt = now + 60000;
    }
  }

  // ── Daily reset check ──────────────────────────────────────────────────
  _resetDailyIfNeeded(bucket) {
    // check if the day rolled over since last save
    const stateFile = path.join(STATE_DIR, `${bucket.config.id}.json`);
    try {
      if (fs.existsSync(stateFile)) {
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (data.lastResetDate !== getTodayStr()) {
          bucket.dailyUsed = 0;
          bucket.dailyNeuronsUsed = 0;
          this._saveProviderState(bucket);
        }
      }
    } catch { /* ignore */ }
  }

  // ── Eligibility check ─────────────────────────────────────────────────
  _isEligible(bucket, estTokens) {
    if (bucket.status === 'dead') return false;

    const now = Date.now();

    // force wait (from server headers)
    if (bucket.nextForceWait > now) return false;

    // concurrency
    if (bucket.activeRequests >= bucket.maxConcurrency) return false;

    // RPM tokens
    this._refillTokens(bucket);
    if (bucket.rpmTokens <= 0) return false;

    // TPM check
    this._resetTpmIfNeeded(bucket);
    if (bucket.tpmUsed + estTokens > bucket.tpmLimit) return false;

    // daily request budget
    if (bucket.dailyUsed >= bucket.dailyLimit) return false;

    // daily neuron budget (cloudflare)
    if (bucket.dailyNeuronsUsed >= bucket.dailyNeuronsLimit) return false;

    // monthly budget (cohere)
    if (bucket.monthlyUsed >= bucket.monthlyLimit) return false;

    return true;
  }

  // ── Getters ─────────────────────────────────────────────────────────────
  get providerCount() {
    return this.buckets.filter(b => b.status !== 'dead').length;
  }

  get totalRPM() {
    return this.buckets
      .filter(b => b.status !== 'dead')
      .reduce((sum, b) => sum + (b.config.limits.rpm || 30), 0);
  }

  // ── State snapshot for dashboard ────────────────────────────────────────
  getState() {
    const now = Date.now();

    const providers = this.buckets.map(b => {
      this._refillTokens(b);
      let status = b.status;
      if (status !== 'dead') {
        if (b.dailyUsed >= b.dailyLimit || b.dailyNeuronsUsed >= b.dailyNeuronsLimit || b.monthlyUsed >= b.monthlyLimit) {
          status = 'exhausted';
        } else if (b.activeRequests >= b.maxConcurrency) {
          status = 'busy';
        } else if (b.rpmTokens <= 0) {
          status = 'cooling';
        } else if (b.nextForceWait > now) {
          status = 'benched';
        } else {
          status = 'ready';
        }
      }

      return {
        id: b.config.id,
        name: b.config.name,
        model: b.config.model,
        rpm: b.config.limits.rpm || '∞',
        status,
        rpmTokens: b.rpmTokens === Infinity ? '∞' : b.rpmTokens,
        rpmMax: b.rpmMax === Infinity ? '∞' : b.rpmMax,
        activeRequests: b.activeRequests,
        maxConcurrency: b.maxConcurrency,
        tpmUsed: b.tpmLimit === Infinity ? null : b.tpmUsed,
        tpmLimit: b.tpmLimit === Infinity ? null : b.tpmLimit,
        dailyUsed: b.dailyLimit === Infinity && b.dailyNeuronsLimit === Infinity ? null : b.dailyUsed,
        dailyLimit: b.dailyLimit === Infinity ? null : b.dailyLimit,
        dailyNeuronsUsed: b.dailyNeuronsLimit === Infinity ? null : b.dailyNeuronsUsed,
        dailyNeuronsLimit: b.dailyNeuronsLimit === Infinity ? null : b.dailyNeuronsLimit,
        monthlyUsed: b.monthlyLimit === Infinity ? null : b.monthlyUsed,
        monthlyLimit: b.monthlyLimit === Infinity ? null : b.monthlyLimit,
        requestsDone: b.requestsDone,
        requestsFailed: b.requestsFailed,
        consecutiveFailures: b.consecutiveFailures,
        lastError: b.lastError,
      };
    });

    // Sort: ready first, then by most RPM tokens available
    providers.sort((a, b) => {
      const statusOrder = { ready: 0, busy: 1, cooling: 2, benched: 3, exhausted: 4, dead: 5 };
      const sa = statusOrder[a.status] ?? 3;
      const sb = statusOrder[b.status] ?? 3;
      if (sa !== sb) return sa - sb;
      return (b.requestsDone || 0) - (a.requestsDone || 0);
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
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        currentRPM: this.totalRPM,
      },
    };
  }

  // ── Dashboard HTTP + SSE server ─────────────────────────────────────────
  _startDashboardServer() {
    const server = http.createServer((req, res) => {
      if (req.url === '/events') {
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
    this.deadProviders.push({
      config: bucket.config,
      reason,
      killedAt: new Date().toISOString(),
    });
    this._persistDeadKey(bucket.config.id, bucket.apiKey, reason);
  }

  // ── Header parsing helper ──────────────────────────────────────────────
  _parseHeaders(bucket, headers) {
    if (!headers) return;

    const remaining = headers.get('x-ratelimit-remaining-requests');
    const remainingTokens = headers.get('x-ratelimit-remaining-tokens');
    const resetRequests = headers.get('x-ratelimit-reset-requests');

    if (remaining !== null && remaining !== undefined) {
      const val = parseInt(remaining, 10);
      if (!isNaN(val)) {
        bucket.rpmTokens = Math.min(val, bucket.rpmMax);
      }
    }

    if (remainingTokens !== null && remainingTokens !== undefined) {
      const val = parseInt(remainingTokens, 10);
      if (!isNaN(val) && bucket.tpmLimit !== Infinity) {
        bucket.tpmUsed = bucket.tpmLimit - val;
      }
    }

    if (resetRequests) {
      const resetMs = parseResetTime(resetRequests);
      if (resetMs > 0 && bucket.rpmTokens <= 0) {
        bucket.nextForceWait = Date.now() + resetMs;
      }
    }
  }

  // ── Core routing method (v2) ───────────────────────────────────────────
  async generateContent(prompt, requireJson = false) {
    let totalRetries = 0;
    this.stats.totalRequests++;
    const estTokens = estimateTokens(prompt);

    while (totalRetries < MAX_TOTAL_RETRIES) {
      // 1. Reset daily counters if date rolled over (check periodically)
      if (totalRetries === 0 || totalRetries % 10 === 0) {
        for (const b of this.buckets) this._resetDailyIfNeeded(b);
      }

      // 2. Find all eligible buckets
      const eligible = this.buckets.filter(b => this._isEligible(b, estTokens));

      if (eligible.length > 0) {
        // 3. Sort: fastest refill rate first, then most tokens, then least loaded
        eligible.sort((a, b) => {
          // prefer providers with more burst capacity first
          if (a.rpmRefillMs !== b.rpmRefillMs) return a.rpmRefillMs - b.rpmRefillMs;
          const aTokens = a.rpmTokens === Infinity ? 9999 : a.rpmTokens;
          const bTokens = b.rpmTokens === Infinity ? 9999 : b.rpmTokens;
          if (aTokens !== bTokens) return bTokens - aTokens;
          return a.activeRequests - b.activeRequests;
        });

        const bestBucket = eligible[0];

        // 4. Consume resources BEFORE the call (atomic)
        bestBucket.rpmTokens = bestBucket.rpmTokens === Infinity
          ? Infinity
          : bestBucket.rpmTokens - 1;
        bestBucket.activeRequests++;

        const providerName = bestBucket.config.name;
        console.log(`[BlackBox] → ${providerName} (${bestBucket.config.model}) [${bestBucket.activeRequests}/${bestBucket.maxConcurrency} active]`);

        try {
          let result;
          let responseHeaders = null;

          const apiCallPromise = (async () => {
            if (bestBucket.config.isGoogle) {
              // Gemini — no header access
              const genConfig = requireJson ? { responseMimeType: 'application/json' } : {};
              const res = await bestBucket.client.generateContent({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: genConfig,
              });
              return { text: res.response.text(), headers: null };
            } else {
              // OpenAI-compatible — use .withResponse() for headers
              const messages = [{ role: 'user', content: prompt }];
              const params = { model: bestBucket.config.model, messages };

              if (requireJson && bestBucket.config.supportsJsonMode) {
                params.response_format = { type: 'json_object' };
              }

              const { data: res, response: raw } = await bestBucket.client.chat.completions
                .create(params)
                .withResponse();

              return {
                text: res.choices[0].message.content,
                headers: raw.headers,
              };
            }
          })();

          // Hard timeout (25s)
          let timeoutId;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('API Socket Timeout (25s)')), 25000);
          });

          try {
            const res = await Promise.race([apiCallPromise, timeoutPromise]);
            result = res.text;
            responseHeaders = res.headers;
          } finally {
            clearTimeout(timeoutId);
          }

          // ── Success! Update all counters ──
          bestBucket.activeRequests--;
          bestBucket.consecutiveFailures = 0;
          bestBucket.requestsDone++;
          bestBucket.lastError = null;
          bestBucket.status = 'ready';
          this.stats.successCount++;

          // daily/monthly/neuron counters
          bestBucket.dailyUsed++;
          bestBucket.monthlyUsed++;
          bestBucket.dailyNeuronsUsed += bestBucket.neuronCostPerRequest || 0;
          bestBucket.tpmUsed += estTokens;

          // parse server headers (overwrites client-side guesses)
          this._parseHeaders(bestBucket, responseHeaders);

          // persist state (debounced)
          this._debouncedSave(bestBucket);

          return result;

        } catch (error) {
          bestBucket.activeRequests--;
          totalRetries++;
          const errMsg = (error && error.message) ? error.message.substring(0, 120) : String(error);
          const status = error.status || error.statusCode || 0;

          bestBucket.requestsFailed++;
          bestBucket.lastError = errMsg;
          bestBucket.consecutiveFailures++;

          // ── Smart penalty (v2) ──
          if (status === 401 || status === 403) {
            console.error(`[BlackBox] ☠️  ${bestBucket.config.name} — DEAD KEY (${status}). Permanently killed.`);
            this._killBucket(bestBucket, `${status} ${errMsg}`);

          } else if (status === 429) {
            // check if we can parse headers from the error
            const errorHeaders = error.headers;
            if (errorHeaders) {
              const resetStr = errorHeaders['x-ratelimit-reset-requests']
                || errorHeaders['x-ratelimit-reset']
                || errorHeaders['retry-after'];
              if (resetStr) {
                const resetMs = parseResetTime(String(resetStr));
                bestBucket.nextForceWait = Date.now() + resetMs;
                console.error(`[BlackBox] ⏳ ${bestBucket.config.name} — 429. Server says wait ${resetMs}ms.`);
              }
            }

            if (/daily|day|TPD/i.test(errMsg)) {
              bestBucket.dailyUsed = bestBucket.dailyLimit;
              console.error(`[BlackBox] 🛑 ${bestBucket.config.name} — Daily quota hit. Exhausted for today.`);
              this._saveProviderState(bestBucket);
            } else if (/monthly|month/i.test(errMsg)) {
              bestBucket.monthlyUsed = bestBucket.monthlyLimit;
              console.error(`[BlackBox] 🛑 ${bestBucket.config.name} — Monthly quota hit. Exhausted for this month.`);
              this._saveProviderState(bestBucket);
            } else if (/token/i.test(errMsg) && bestBucket.tpmLimit !== Infinity) {
              bestBucket.tpmUsed = bestBucket.tpmLimit;
              console.error(`[BlackBox] ⚠️  ${bestBucket.config.name} — TPM limit hit. Waiting for reset.`);
            } else {
              // generic 429 — drain RPM tokens, they'll refill naturally
              bestBucket.rpmTokens = 0;
              bestBucket.lastRpmRefill = Date.now();
              if (!bestBucket.nextForceWait || bestBucket.nextForceWait <= Date.now()) {
                // fallback: if no header told us when to retry, wait 1 refill cycle
                bestBucket.nextForceWait = Date.now() + (bestBucket.rpmRefillMs || 60000);
              }
              console.error(`[BlackBox] ⚠️  ${bestBucket.config.name} — 429 rate limited. Tokens drained, will refill.`);
            }
          } else {
            // generic error (timeout, 500, etc) — bench for 30s
            bestBucket.nextForceWait = Date.now() + 30000;
            bestBucket.status = 'cooling';
            console.error(`[BlackBox] ⚠️  ${bestBucket.config.name} — ${errMsg}. Benching 30s.`);
          }
        }

      } else {
        // ── No eligible buckets — calculate sleep time ──
        const now = Date.now();
        let minWaitMs = Infinity;

        for (const bucket of this.buckets) {
          if (bucket.status === 'dead') continue;
          if (bucket.dailyUsed >= bucket.dailyLimit) continue;
          if (bucket.dailyNeuronsUsed >= bucket.dailyNeuronsLimit) continue;
          if (bucket.monthlyUsed >= bucket.monthlyLimit) continue;

          // next RPM refill
          if (bucket.rpmTokens <= 0 && bucket.rpmRefillMs > 0) {
            const elapsed = now - bucket.lastRpmRefill;
            const waitForToken = bucket.rpmRefillMs - elapsed;
            if (waitForToken > 0 && waitForToken < minWaitMs) minWaitMs = waitForToken;
          }

          // force wait
          if (bucket.nextForceWait > now) {
            const wait = bucket.nextForceWait - now;
            if (wait < minWaitMs) minWaitMs = wait;
          }

          // TPM reset
          if (bucket.tpmUsed + estTokens > bucket.tpmLimit) {
            const wait = bucket.tpmResetAt - now;
            if (wait > 0 && wait < minWaitMs) minWaitMs = wait;
          }

          // concurrency — someone will finish eventually, short sleep
          if (bucket.activeRequests >= bucket.maxConcurrency) {
            if (500 < minWaitMs) minWaitMs = 500;
          }
        }

        if (minWaitMs === Infinity) {
          this.stats.failCount++;
          throw new Error('[BlackBox] All providers are exhausted (daily/monthly limits or dead keys). Cannot process.');
        }

        if (!this._lastSleepLog || Date.now() - this._lastSleepLog > 2000) {
          console.log(`\n[BlackBox] 💤 All providers busy. Sleeping ${Math.round(minWaitMs)}ms...`);
          this._lastSleepLog = Date.now();
        }

        await delay(Math.min(minWaitMs, 60000));
        totalRetries++;
      }
    }

    this.stats.failCount++;
    throw new Error(`[BlackBox] Exhausted ${MAX_TOTAL_RETRIES} retries across all providers.`);
  }
}

// ── Singleton export ────────────────────────────────────────────────────────
const blackBox = new BlackBoxRouter();
module.exports = blackBox;
