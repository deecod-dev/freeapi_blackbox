# api blackbox

i built this because i needed to make thousands of llm calls per minute for a project and kept getting slammed by rate limits. paying wasn't really an option so i just grabbed a bunch of free tier keys from different providers and compiled this router for my own convenience. 

it just sits between the app and the providers, routing prompts to whoever is fastest.

## benchmarks

in a stress test of 30 short queries under high concurrency:
- **600.0 burst rpm** achieved with a **100% success rate** under 9 concurrent workers (average latency of 0.81s). 
*(note: this is an extrapolated burst rpm from a 3-second window. the tokens were consumed rapidly before any hard rate limits kicked in.)*

in a longer stress test of 300 queries under extreme load:
- **416.5 sustained rpm** achieved with a **98.0% success rate** under 40 concurrent workers. 

under the hood, even though 5 keys were active at the start of the 40-concurrency test, 4 of them (nvidia, cohere, github, cerebras) hit rate limits or timeouts mid-run. the router benched them and redirected 100% of the traffic to **cloudflare workers ai**, which single-handedly processed the entire load without breaking.

### theoretical limits
if all 11 keys in the default configuration are working at their standard free-tier limits, blackbox can achieve:
- **theoretical max concurrency:** 36 concurrent requests
- **theoretical max sustained throughput:** ~540 requests per minute (rpm)

## methodology

most rate limiters use queues. queues consume memory and get stuck. i didn't want to deal with that.

so instead, it's stateless. every provider has a drop rate (the exact time needed between calls to not get banned). when you send a request, it checks who has cooled down. if someone is ready, it fires. if everyone is busy, it calculates the exact microsecond the next one will be free and uses node's event loop to sleep the request until then. no queues, no bloat.

by compiling all these free tiers, the theoretical throughput is around 1,700 requests per minute across 11 providers. the models it cycles through are: cloudflare llama-3.1 (8B), mistral nemo (12B), groq llama-3.3 (70B), cerebras gpt-oss (120B), openrouter mistral nemo (12B), github gpt-4o-mini (proprietary), zhipu glm-4 flash (proprietary), cohere command r+ (104B), nvidia llama-3.1 (8B), huggingface llama-3 (8B), and gemini flash (proprietary). some models repeat across providers but each one has its own separate rate limit so they all add up.

### handling dead keys

api keys die. sometimes you run out of credits (402), hit hard limits (429), or get banned (401/403).

if a provider throws a temporary error or timeout, blackbox benches it for 60 seconds and reroutes the traffic to the remaining providers.

if it detects a hard failure like an unauthorized error, it marks the key as permanently dead and writes it to a local file (data/dead_keys.json). on future reboots, blackbox will read this file and completely ignore that key so your application never attempts to use it again.

## parameters

if you want to tweak things, check out `src/index.js`:

1. `dropRateMs`: inside the `PROVIDERS` array. lower this number if you get a paid tier and want more throughput.
2. `DASHBOARD_PORT`: it spins up a live dashboard. it's on 3737 by default but you can change it at the top of the file.

## usage

install dependencies using:

```bash
npm install
```

checkout the env file it has any further info you might need.


usage:

```javascript
const blackBox = require('./src/index.js');

async function main() {
  const prompts = Array.from({ length: 20 }, (_, i) => `tell me something about ${i}`);
  
  const promises = prompts.map(p => blackBox.generateContent(p, false));
  const results = await Promise.all(promises);
  
  console.log(results);
}

main();
```

## viewing working:

it'll open a local dashboard server on port 3737 when it boots. open `localhost:3737` in the browser to see live provider stats, request counts, and which keys are alive or dead.