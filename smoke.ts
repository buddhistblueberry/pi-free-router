/**
 * Standalone smoke test — runs the gateway WITHOUT Pi to validate routing,
 * fallback, circuit-breaker cooldown and SSE re-emit. Used during dev / CI.
 *
 *   bun smoke.ts
 *   # in another shell:
 *   curl http://127.0.0.1:8731/v1/chat/completions -d '{"model":"fr-broken","messages":[{"role":"user","content":"hi"}],"stream":false}'
 *   curl http://127.0.0.1:8731/v1/stats
 */
import { createGateway, type GatewayConfig } from "./gateway";

const cfg: GatewayConfig = {
  port: 8731,
  strategy: "priority",
  cooldownMs: 8000,
  providers: [
    {
      // Deliberately broken first → proves fallback + cooldown kicks in.
      id: "broken",
      label: "Broken (should cool down)",
      baseUrl: "http://127.0.0.1:1/openai",
      apiKey: "",
      model: "x",
      piModel: "fr-broken",
      contextWindow: 128000,
      maxTokens: 4096,
      supportsTools: false,
      enabled: true,
    },
    {
      id: "pollinations",
      label: "Pollinations (keyless)",
      baseUrl: "https://text.pollinations.ai/openai",
      apiKey: "",
      model: "openai-fast",
      piModel: "fr-pollinations-fast",
      contextWindow: 128000,
      maxTokens: 4096,
      supportsTools: false,
      enabled: true,
    },
  ],
};

const g = await createGateway(cfg).start();
console.log(`[smoke] gateway up on 127.0.0.1:${g.port}`);
console.log(`[smoke] request model "fr-broken" (broken first) → should fall back to Pollinations and cool down broken`);

const stop = () => {
  g.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setTimeout(stop, 30000);
