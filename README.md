# API BlackBox

**API BlackBox** is a robust, highly parallelized, intelligent routing engine for multiple LLM providers (OpenAI, Anthropic, Google, Mistral, Cloudflare, etc.). It acts as a single endpoint for your application, automatically routing your prompts to the fastest available model, handling rate limits mathematically perfectly, bypassing "dead" or exhausted API keys, and providing a live beautiful dashboard to monitor your traffic.

---

## 🧠 How it Works

BlackBox is designed for massive parallelism. Instead of hitting a single API until it rate-limits (429) and then waiting, BlackBox load-balances your requests across **12 different AI providers**. 

It uses a **Token Bucket / Drop Rate algorithm**:
1. Every provider in the configuration has a `dropRateMs` (e.g., 40ms for Cloudflare, 2000ms for Groq). This represents the exact amount of time required between consecutive API calls to that specific provider to stay perfectly under their free-tier limits.
2. When you call `blackBox.generateContent()`, the engine scans all enabled providers.
3. It calculates exactly how much time has passed since the *last* request to each provider.
4. **Instant Match:** If a provider has "cooled down" (time passed >= `dropRateMs`), it is immediately selected. If multiple are ready, the fastest one (lowest `dropRateMs`) wins.
5. **Wait Match:** If *no* providers are currently ready, BlackBox calculates the exact millisecond when the *soonest* provider will become ready, pauses execution for precisely that long, and then fires the request.

### 🏆 The "Zero-Queue" Advantage (Why this is the best scheduling algorithm)
Unlike traditional systems that use a heavy Array-based Queue where requests wait in line, BlackBox is **Stateless and Queue-less**. 
By utilizing Node.js's asynchronous Event Loop, if a provider isn't ready, the request simply goes to "sleep" (`await delay(...)`) and wakes up at the mathematically perfect microsecond that the API limit resets. 
- **Zero Memory Overhead:** No massive queues taking up RAM.
- **Infinite Concurrency:** You can throw 10,000 `Promise.all` requests at it simultaneously, and they will perfectly weave themselves through the event loop timeline without crashing your app or the APIs.

This means you can spawn 100 concurrent requests, and BlackBox will seamlessly weave them through your API keys in parallel without ever hitting rate limits.

### Theoretical RPM (Requests Per Minute)
Out of the box, configured for free-tier limits, BlackBox achieves a theoretical throughput of **~1,700+ RPM**:

| Provider | Drop Rate (ms) | Theoretical RPM |
|----------|----------------|-----------------|
| Cloudflare Workers AI | 40ms | 1,500 RPM |
| Mistral | 1000ms | 60 RPM |
| Groq | 2000ms | 30 RPM |
| Cerebras | 2000ms | 30 RPM |
| OpenRouter | 3000ms | 20 RPM |
| GitHub Models | 4000ms | 15 RPM |
| Zhipu AI | 5000ms | 12 RPM |
| Cohere | 6000ms | 10 RPM |
| NVIDIA NIM | 6000ms | 10 RPM |
| HuggingFace | 6000ms | 10 RPM |
| Gemini | 6000ms | 10 RPM |
| OpenAI | 6000ms | 10 RPM |
| **Total Combined** | | **~1,717 RPM** |

### 💀 Dead Key Detection
If an API key runs out of credits (402), gets rate limited due to external factors (429), or is unauthorized (401/403), BlackBox catches the error.
- **Temporary Bans:** For 429s or timeouts, the provider is "benched" for 60 seconds, allowing traffic to flow to other providers seamlessly.
- **Permanent Bans:** For 401/403s, the key is marked as "dead" and written to `./data/dead_keys.json`. BlackBox will permanently skip this key on all future boots unless you fix it in your `.env`.

---

## ⚙️ Modifiable Factors & Tuning

If you want to modify how the parallelism works, everything is cleanly exposed in `src/index.js`.

### 1. Adjusting Provider Speed (`dropRateMs`)
If you upgrade to a paid tier on Groq, you don't want to be limited to 30 RPM. You can open `src/index.js`, find the `PROVIDERS` array, and change:
```javascript
{
  id: 'groq',
  name: 'Groq',
  dropRateMs: 200, // Changed from 2000ms to 200ms -> Now allows 300 RPM!
  model: 'llama-3.3-70b-versatile',
  // ...
}
```

### 2. Adding / Changing Models
Want to use `gpt-4o` instead of `gpt-3.5`? Just change the `model` string in the `PROVIDERS` configuration block. The engine automatically handles formatting the request properly based on whether the provider is OpenAI-compatible or requires special formatting (like Gemini or Cloudflare).

### 3. Dashboard Port
By default, the dashboard spins up on `http://localhost:3737`. You can change `DASHBOARD_PORT = 3737` at the top of `src/index.js`.

---

## 🚀 Installation & Usage

1. Clone this repository or copy the code.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the `.env.example` file to `.env` and fill in your API keys (you only need to fill in the ones you want to use!):
   ```bash
   cp .env.example .env
   ```

### Quick Start Code
```javascript
const blackBox = require('./src/index.js');

async function main() {
  // Spawn 20 requests in parallel!
  const prompts = Array.from({ length: 20 }, (_, i) => `Tell me a fun fact about the number ${i}`);
  
  console.log("Sending 20 requests in parallel...");
  
  // BlackBox handles all the routing and rate-limiting automatically
  const promises = prompts.map(p => blackBox.generateContent(p, false));
  
  const results = await Promise.all(promises);
  results.forEach((res, i) => console.log(`Result ${i}: ${res.substring(0, 50)}...`));
}

main();
```

### Live Dashboard
The moment `blackBox.generateContent()` is called, a live web dashboard spins up in the background. Open your browser to:
`http://localhost:3737`
You will see real-time RPM, provider health, API usage stats, and live terminal logs flowing through the UI.
