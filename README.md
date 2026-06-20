# API BlackBox

We originally built this because we were building an application that needed to make thousands of LLM calls, but we kept hitting 429 rate limits on the free tiers. Paying for higher tiers wasn't an option at the time, so we needed a way to aggregate multiple free API keys and use them simultaneously without ever crashing or dropping a request.

API BlackBox is a routing engine that sits between your application and the LLM providers. You give it a prompt, and it automatically routes it to the fastest available model among providers like OpenAI, Mistral, Cloudflare, Groq, Cerebras, and others.

It also spins up a local dashboard on port 3737 so you can watch the traffic flow in real time.

## The Architecture

Most rate limiters or API routers use an array-based queue. Requests sit in memory waiting for their turn, which eventually causes bottlenecks or memory bloat when dealing with heavy concurrency. 

We took a different approach. BlackBox is entirely stateless and queue-less. 

We assigned every provider a specific "drop rate" representing the exact milliseconds required between consecutive calls to stay under their free-tier limits (for example, Cloudflare is set to 40ms, while Groq is set to 2000ms). When you send a request to BlackBox, it scans all configured providers. If a provider has cooled down past its drop rate, the request is sent there instantly. If multiple are ready, the fastest one wins.

If all providers are currently busy, BlackBox doesn't queue the request. Instead, it calculates the exact millisecond the soonest provider will become available, and uses the Node.js event loop to put the request to sleep until that exact moment. 

Because it relies purely on the native event loop rather than managing state, you can throw thousands of concurrent promises at it and they will flawlessly weave themselves through the timeline. Combining the default free tiers across all 12 providers gives a theoretical throughput of roughly 1,700 requests per minute.

## Handling Dead Keys

API keys die. Sometimes you run out of credits (402), hit hard limits (429), or get banned (401/403). 

If a provider throws a temporary error or timeout, BlackBox benches it for 60 seconds and seamlessly reroutes the traffic to the remaining providers. 

If it detects a hard failure like an unauthorized error, it marks the key as permanently dead and writes it to a local file (`data/dead_keys.json`). On future reboots, BlackBox will read this file and completely ignore that key so your application never attempts to use it again.

## Modifying the Limits

If you upgrade a specific provider to a paid tier, you won't want to be limited to the free tier drop rate anymore. 

You can easily adjust this by opening `src/index.js`, finding the `PROVIDERS` array, and lowering the `dropRateMs`. For example, changing Groq's drop rate from 2000ms to 200ms instantly increases its allowed throughput to 300 requests per minute.

## Installation and Usage

Clone the code and install the necessary dependencies:

```bash
npm install
```

Copy the example environment file and fill in the API keys for the providers you actually want to use. You can leave the rest blank.

```bash
cp .env.example .env
```

To use it in your code, simply import the index file and pass it your prompt. The second argument determines if you want the output forced into JSON format (if the chosen provider supports it).

```javascript
const blackBox = require('./src/index.js');

async function main() {
  const prompts = Array.from({ length: 20 }, (_, i) => `Tell me a fun fact about the number ${i}`);
  
  // Send 20 requests in parallel. BlackBox handles the routing and rate-limiting.
  const promises = prompts.map(p => blackBox.generateContent(p, false));
  
  const results = await Promise.all(promises);
  results.forEach((res, i) => console.log(`Result ${i}: ${res.substring(0, 50)}...`));
}

main();
```

As soon as `generateContent()` is called, the live dashboard will start at `http://localhost:3737`.
