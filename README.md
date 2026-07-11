# pi-free-router

A **free-tier API gateway for Pi** — an [OmniRoute](https://github.com/diegosouzapw/OmniRoute)-style
local LLM router, shipped as a **Pi extension** with **zero native dependencies**.

> **Why this exists:** OmniRoute aggregates ~237 providers with routing, circuit breakers, and
> auto-fallback, but its native dependencies (`better-sqlite3`, etc.) fail to compile on
> Termux/Android. This is the same architecture — minus the parts that need native builds —
> running **inside the Pi extension process**. No separate binary, no compilation.

---

## What makes it work (ported from OmniRoute)

| Feature | What it does | OmniRoute origin |
|---------|-------------|-----------------|
| **Pluggable routing strategies** | `priority`, `round-robin`, `random`, `cost`, `latency`, `lkgp` | `routerStrategy.ts` |
| **Circuit breaker** | Per-provider CLOSED→DEGRADED→OPEN→HALF_OPEN w/ exponential backoff | `circuitBreaker.ts` |
| **Kind-aware cooldown** | Different cooldowns for rate_limit vs quota_exhausted vs transient | `cooldownByKind` |
| **Retry-After respect** | Parses upstream `Retry-After` headers for precise cooldown | `cooldownAwareRetry.ts` |
| **Combo system** | Named model chains with fallback (e.g. `fr-combo-free-smart`) | `combo.ts` |
| **Global fallback** | Last-resort provider when all others fail | `chat.ts` globalFallbackModel |
| **SSE pass-through** | True streaming pass-through instead of buffered re-emission | `streaming.ts` |
| **Provider catalog** | 35+ free/ keyless providers curated from OmniRoute's 237 | `FREE_TIERS.md` |
| **Health/stats** | `/v1/stats`, `/v1/health`, circuit breaker views | `resilience` API |
| **Resilience tracing** | Each request logs its fallback chain and provider decisions | `resilienceTrace` |
| **Zero native deps** | Pure `node:http` + `fetch` — no `better-sqlite3`, no compilation | — |

---

## Architecture

```
Pi  ──OpenAI-completions HTTP──▶  127.0.0.1:8731/v1/chat/completions
                                   │
                                   ▼
                      free-router gateway (HTTP server inside the extension)
                                   │
                                   ├── Routing strategy (priority / round-robin / cost / etc.)
                                   ├── Circuit breaker per provider (states + kind-aware cooldown)
                                   ├── Combo resolution (named provider chains)
                                   ├── SSE pass-through streaming
                                   ├── Global fallback (last resort)
                                   └── Health / stats endpoints
                                   │
                                   ▼
        [LLM7·keyless] → [Groq·keyed] → [DeepSeek·keyed] → [Gemini·keyed] → …
              (auto-fallback on 429 / 5xx / timeout / circuit open)
```

Pi sees **one provider** (`free-router`) with many models. The gateway does the
routing, circuit breaking, and fallback. That is the OmniRoute pattern.

The default config ships with **keyless providers enabled** (LLM7, Pollinations)
for zero-setup testing. Enable keyed providers by setting env vars and flipping
`"enabled": true` in `~/.pi/agent/free-router.json`, then `/reload`.

---

## Quick start

### Install

```bash
git clone https://github.com/buddhistblueberry/pi-free-router \
  ~/.pi/agent/extensions/pi-free-router
```

Then in Pi run `/reload`. The provider appears as **Free Router**.

### First run (zero setup)

The default config enables LLM7 and Pollinations (keyless) — just:

```
/reload
/model fr-auto
```

Then chat. The gateway fans across all enabled providers, falling back on failure.

### Enable more providers

Edit `~/.pi/agent/free-router.json`, set env vars, flip `enabled: true`, then:

```
/free-router-reload
```

### Commands

| Command | Description |
|---------|-------------|
| `/free-router-status` | Show gateway status, provider pool, circuit breakers, combos |
| `/free-router-strategy <name>` | Switch routing strategy on the fly |
| `/free-router-reset <id\|all>` | Reset circuit breaker for a provider |
| `/free-router-reload` | Reload config from `free-router.json` |

### Models

| Model | What it does |
|-------|-------------|
| `fr-auto` | Fans across ALL enabled providers with fallback |
| `fr-llm7` | LLM7 (keyless, no signup) |
| `fr-pollinations-fast` | Pollinations (keyless, no signup) |
| `fr-groq-70b` | Groq Llama 3.3 70B (needs `$GROQ_API_KEY`) |
| `fr-deepseek-chat` | DeepSeek Chat (needs `$DEEPSEEK_API_KEY`) |
| `fr-gemini-flash` | Google Gemini 2.5 Flash (needs `$GOOGLE_API_KEY`) |
| `fr-auto-all` | Combo: all enabled providers (auto) |
| `fr-combo-free-fast` | Combo: Groq Fast → Groq 70B → Cerebras → DeepSeek |
| `fr-combo-free-smart` | Combo: Gemini → Mistral → DeepSeek → LLM7 |

Plus many more — see the full catalog in `config.ts`.

---

## Configuration

Config lives at `~/.pi/agent/free-router.json` (auto-created from defaults on first load).

```json
{
  "port": 8731,
  "strategy": "priority",
  "cooldownMs": 60000,
  "circuitBreakerThreshold": 5,
  "cooldownByKind": {
    "rate_limit": 60000,
    "quota_exhausted": 300000,
    "transient": 30000
  },
  "globalFallbackProvider": "llm7",
  "providers": [
    {
      "id": "groq",
      "label": "Groq (free tier, tools)",
      "baseUrl": "https://api.groq.com/openai",
      "apiKey": "$GROQ_API_KEY",
      "model": "llama-3.3-70b-versatile",
      "piModel": "fr-groq-70b",
      "contextWindow": 128000,
      "maxTokens": 4096,
      "supportsTools": true,
      "enabled": true,
      "category": "free",
      "freeTierNotes": "~15M tokens/mo, 30 RPM"
    }
  ],
  "combos": [
    {
      "name": "fr-combo-free-smart",
      "providerIds": ["gemini", "mistral", "deepseek", "llm7"],
      "strategy": "priority"
    }
  ]
}
```

### Provider catalog (curated from OmniRoute)

The default config includes **35+ providers** from OmniRoute's catalog of 237.
Only keyless ones are enabled by default. Full list in `config.ts`. Highlights:

| Provider | Pi model | Category | Free tier | Tools |
|----------|----------|----------|-----------|-------|
| LLM7 | `fr-llm7` | ✅ keyless | ~150M tok/mo | no |
| Pollinations | `fr-pollinations-fast` | ✅ keyless | Free keyless | no |
| FreeModel.dev | `fr-free-model` | ✅ keyless | $300 free credits | no |
| Groq | `fr-groq-70b` | 🔑 keyed | ~15M tok/mo, fast | yes |
| DeepSeek | `fr-deepseek-chat` | 🔑 keyed | 5M free signup | yes |
| Gemini | `fr-gemini-flash` | 🔑 keyed | ~60M tok/mo, 128K ctx | yes |
| Mistral | `fr-mistral-small` | 🔑 keyed | ~1B tok/mo free tier | yes |
| Cerebras | `fr-cerebras-llama33` | 🔑 keyed | ~30M tok/mo, fast | yes |
| Together | `fr-together-llama33` | 🔑 keyed | $25 free credits | yes |
| OpenRouter | `fr-openrouter-gpt4o-mini` | 🔑 keyed | Free `:free` models | yes |
| NVIDIA NIM | `fr-nim-llama33` | 🔑 keyed | 40 RPM, 70+ models | no |
| DeepInfra | `fr-deepinfra-llama33` | 🔑 keyed | Free credits | yes |
| SiliconFlow | `fr-siliconflow-qwen` | 🔑 keyed | Free after KYC | yes |
| Cloudflare | `fr-cf-llama33` | 🔑 keyed | ~30M tok/mo | no |
| GitHub Models | `fr-gh-models` | 🔑 keyed | ~18M tok/mo (closing) | yes |
| API Airforce | `fr-airforce` | 🔑 keyed | 55 free models | no |
| OpenAI | `fr-openai-mini` | 💳 paid | — | yes |
| Anthropic | `fr-anthropic-sonnet` | 💳 paid | — | yes |

---

## Routing strategies

Use `/free-router-strategy <name>` to switch at runtime.

| Strategy | Description |
|----------|-------------|
| `priority` | Requested provider first, then rest by config order |
| `round-robin` | Cycle through providers evenly |
| `random` | Pick a random provider, then fallback |
| `cost` | Prefer cheapest (by `costPer1MTokens`) |
| `latency` | Prefer fastest (by `avgE2ELatencyMs`) |
| `lkgp` | Last Known Good Provider first, then fallback |

---

## Circuit breaker

Every provider has a circuit breaker with states:

```
CLOSED  →  DEGRADED  →  OPEN  →  HALF_OPEN  →  CLOSED
  │          │           │            │
  normal    warning    refused     probing recovery
```

- **CLOSED**: Normal operation, requests pass through
- **DEGRADED**: Elevated failure rate, requests still pass but warnings logged
- **OPEN**: Requests short-circuited, provider skipped
- **HALF_OPEN**: After cooldown, probe requests allowed to test recovery

Kind-aware cooldown: `rate_limit` (60s) vs `quota_exhausted` (5min) vs `transient` (30s).
Exponential backoff on repeated open cycles (up to 16x base timeout).

Reset with `/free-router-reset <providerId>` or `/free-router-reset all`.

---

## API endpoints (standalone)

The gateway speaks the OpenAI API. Test without Pi:

```bash
# List models
curl http://127.0.0.1:8731/v1/models

# Chat (non-streaming)
curl -s http://127.0.0.1:8731/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"fr-auto","messages":[{"role":"user","content":"say hi"}],"stream":false}'

# Chat (streaming)
curl -s http://127.0.0.1:8731/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"fr-llm7","messages":[{"role":"user","content":"count to 5"}],"stream":true}'

# Health / stats
curl http://127.0.0.1:8731/v1/stats
curl http://127.0.0.1:8731/healthz

# Reset a circuit breaker
curl -X POST http://127.0.0.1:8731/v1/reset-breaker \
  -H 'content-type: application/json' \
  -d '{"providerId": "groq"}'
```

---

## What's ported from OmniRoute vs intentionally excluded

### Ported ✅
- Pluggable routing strategies (6 strategies + registry)
- Circuit breaker with CLOSED→DEGRADED→OPEN→HALF_OPEN (kind-aware, exponential backoff)
- Retry-After aware cooldown
- Combo system (named model chains + virtual auto combo)
- Global fallback (last-resort provider)
- SSE pass-through streaming (true streaming, not buffered)
- Resilience tracing per request
- Provider catalog (35+ free-tier providers from OmniRoute's 237)
- Health / stats / breaker-reset endpoints

### Intentionally excluded ❌
- No `better-sqlite3` dashboard / UI (needs native build)
- No MITM / TPROXY / TLS JA3 (needs native + root)
- No Electron desktop app
- No multi-account quota sharing
- No OAuth / Web Cookie providers (those are OmniRoute-specific auth flows)
- No token compression (RTK/Caveman — needs native or heavy libs)
- No persistent DB (in-memory only — state resets on restart)

---

## Development

```bash
# The gateway can be tested standalone without Pi:
cd ~/.pi/agent/extensions/pi-free-router
node --loader ts-node/esm smoke.ts
```

See `gateway.ts` for the standalone module — zero Pi dependencies.

## License

MIT
