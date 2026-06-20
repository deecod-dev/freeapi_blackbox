# api blackbox

i built this because i needed to make thousands of llm calls per minute for a project and kept getting slammed by rate limits. paying wasn't really an option so i just grabbed a bunch of free tier keys from different providers and compiled this router for my own convenience. 

it just sits between the app and the providers, routing prompts to whoever is fastest.

## methodology

most rate limiters use queues. queues consume memory and get stuck. i didn't want to deal with that.

so instead, it's stateless. every provider has a drop rate (the exact time needed between calls to not get banned). when you send a request, it checks who has cooled down. if someone is ready, it fires. if everyone is busy, it calculates the exact microsecond the next one will be free and uses node's event loop to sleep the request until then. no queues, no bloat.

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
