/**
 * Standalone smoke test — runs the gateway WITHOUT Pi to validate routing,
 * streaming passthrough and fallback. Used during development / CI.
 *
 *   bun smoke.ts            # starts gateway on :8731, exits after 30s
 *   # in another shell:  curl http://127.0.0.1:8731/v1/chat/completions ...
 */
import { createGateway, type GatewayConfig } from "./gateway";

const cfg: GatewayConfig = {
  port: 8731,
  strategy: "priority",
  providers: [
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
console.log(`[smoke] Free Router gateway up on 127.0.0.1:${g.port}`);
console.log(`[smoke] try: curl -s http://127.0.0.1:${g.port}/v1/chat/completions -H 'content-type: application/json' -d '{"model":"fr-pollinations-fast","messages":[{"role":"user","content":"say hi in 3 words"}],"stream":false}'`);

const stop = () => {
  g.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setTimeout(stop, 30000);
