# pi-free-router

A **free-tier API key wrapper for Pi** — an [OmniRoute](https://github.com/diegosouzapw/OmniRoute)-style
local gateway, shipped as a **Pi extension** with **zero native dependencies**.

> Why this exists: OmniRoute is great but pulls in native builds (e.g. `better-sqlite3`)
> that fail to compile on Termux/Android. Pi already speaks the OpenAI Chat Completions
> protocol, so the useful 10% — *one endpoint, many free providers, auto-fallback* — can be
> a tiny pure-TypeScript gateway that runs **inside the extension process**. No separate
> binary, no compilation.

---

## What it does

```
Pi  ──OpenAI-completions HTTP──▶  127.0.0.1:8731/v1/chat/completions
                                   │
                                   ▼
                      free-router gateway  (HTTP server inside the extension)
                                   │  pi-model-id → upstream target
                                   ▼  fallback on 429 / 5xx / hang
        [Pollinations·keyless] → [Groq] → [Together] → [DeepSeek] → [OpenRouter] …
```

Pi sees **one provider** (`free-router`) with many models. The gateway does the
routing and fallback. That is the OmniRoute pattern, minus the parts that need
native deps or are overkill.

Works **out of the box with no API key** (default pool = keyless Pollinations).

---

## Install (it "falls into Pi")

### Option A — clone into extensions (simplest)
```bash
git clone https://github.com/buddhistblueberry/pi-free-router \
  ~/.pi/agent/extensions/pi-free-router
```
Then in Pi run `/reload`. The provider appears as **Free Router**; pick a model
with `/model` (e.g. `fr-pollinations-fast`).

### Option B — Pi package (git)
Add to your `settings.json`:
```json
{ "packages": ["git:github.com/buddhistblueberry/pi-free-router"] }
```
Then `pi install`.

---

## Usage

1. Load it (`/reload` if cloned). On `session_start` the gateway binds `127.0.0.1:8731`.
2. `/model` → choose a `Free Router` model (default: `fr-pollinations-fast`).
3. Chat. If a provider is rate-limited or errors, the gateway silently retries the next one.
4. `/free-router-status` shows the live pool and gateway URL.

---

## Configuration

Config lives at `~/.pi/agent/free-router.json` (auto-created from defaults on first load).

```json
{
  "port": 8731,
  "strategy": "priority",
  "providers": [
    {
      "id": "pollinations",
      "label": "Pollinations (keyless)",
      "baseUrl": "https://text.pollinations.ai/openai",
      "apiKey": "",
      "model": "openai-fast",
      "piModel": "fr-pollinations-fast",
      "contextWindow": 128000,
      "maxTokens": 4096,
      "supportsTools": false,
      "enabled": true
    }
  ]
}
```

Add keyed free tiers to unlock tool-calling and better models:

| Provider   | baseUrl                              | Notes                                  |
|------------|--------------------------------------|----------------------------------------|
| Groq       | `https://api.groq.com/openai`        | fast, `supportsTools: true`            |
| Together   | `https://api.together.xyz/v1`        | `supportsTools: true`                  |
| DeepSeek   | `https://api.deepseek.com/v1`        | `supportsTools: true`                  |
| OpenRouter | `https://openrouter.ai/api/v1`       | huge model catalog, free tier models   |

`apiKey` accepts an env reference (`"$GROQ_API_KEY"`) or a literal. After editing,
`/reload` in Pi and re-select the model.

`strategy`: `priority` (requested provider first, then rest), `round-robin`, `random`.
`cooldownMs`: how long (ms) a failed provider is skipped before retry (default 60000).

A keyed **Groq** provider (`fr-groq-70b`, `supportsTools: true`) ships **disabled** in the
default config. To enable tool-calling on a faster model, set `GROQ_API_KEY` and flip
`"enabled": true` on that entry, then `/reload` in Pi.

---

## Development / testing (no Pi needed)

The gateway is dependency-free and Pi-agnostic, so it can be tested standalone:

```bash
bun smoke.ts
# another shell:
curl -s http://127.0.0.1:8731/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"fr-pollinations-fast","messages":[{"role":"user","content":"say hi in 3 words"}],"stream":false}'
```

---

## Resilience

- **Circuit breaker / cooldown**: a provider that fails (429 / 5xx / timeout / network /
  error-as-200) is skipped for `cooldownMs` (default 60s) and retried afterwards. Live state:
  `curl http://127.0.0.1:8731/v1/stats` or the in-Pi `/free-router-status` command.
- **Fallback**: the next provider in the pool is tried automatically — you never see the error.

## Limitations (vs full OmniRoute)

Intentionally out of scope for v1 (these are what needed native builds / are overkill):
- No `better-sqlite3` dashboard, MITM/TPROXY, TLS JA3 stealth, Electron, or multi-account quota-share.
- Mid-stream fallback is impossible (a provider can't be swapped after tokens start); a
  mid-stream failure surfaces an error Pi retries.
- Most free models lack extended thinking → registered with `reasoning: false`.
- Tool-call support is per-provider (`supportsTools`); non-tool providers have `tools` stripped.
- **Upstream calls are made non-streaming and re-emitted as SSE to Pi.** This dodges a
  runtime quirk (Bun's `fetch` streaming hangs on some free providers) and is uniform across
  all providers. True pass-through streaming is future work — you still get streamed output in
  Pi, just buffered per upstream response.

## Roadmap
- [ ] JSON-file usage/quota tracking + "free tokens remaining" in status
- [x] Circuit breaker / key cooldown on failure
- [x] Routing strategies: `priority` / `round-robin` / `random`
- [ ] Optional prompt compression (dedup/truncate tool outputs) before forwarding

## License
MIT
