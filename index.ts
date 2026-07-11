import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGateway, type GatewayHandle, type ProviderEntry } from "./gateway";
import { loadConfig, CONFIG_PATH } from "./config";

/**
 * Pi extension entry point.
 *
 * Responsibilities:
 *  1. Register ONE Pi provider ("free-router") whose baseUrl points at the
 *     in-process gateway. Pi does all OpenAI-completions serialization,
 *     streaming, tool-call parsing and cost math — we only route.
 *  2. Start the gateway HTTP server on session_start (and stop it on shutdown).
 *  3. Normalize upstream context-overflow errors so Pi auto-compacts + retries.
 *  4. Expose /free-router-status for visibility.
 */
export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const port = config.port || 8731;

  // Pi-facing model catalog derived from the pool.
  const models = config.providers
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.piModel,
      name: p.label,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: p.contextWindow,
      maxTokens: p.maxTokens,
    }));

  pi.registerProvider("free-router", {
    name: "Free Router",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    // The gateway is localhost and holds the real upstream keys; this is a dummy.
    apiKey: "not-needed",
    api: "openai-completions",
    models,
  });

  let handle: GatewayHandle | null = null;

  pi.on("session_start", async (_e, ctx) => {
    if (handle) return; // already running in this process
    try {
      handle = await createGateway(config).start();
      ctx.ui?.notify?.(
        `Free Router gateway listening on 127.0.0.1:${port}`,
        "info",
      );
    } catch (err: any) {
      ctx.ui?.notify?.(
        `Free Router gateway failed: ${err?.message ?? err}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", () => {
    try {
      handle?.close();
    } catch {}
    handle = null;
  });

  // Make Pi treat upstream context-overflow like its own, so it compacts + retries.
  pi.on("message_end", (event) => {
    const m = event.message;
    if (m.role !== "assistant" || m.stopReason !== "error") return;
    if (m.provider !== "free-router") return;
    const msg = m.errorMessage ?? "";
    if (msg.includes("context_length_exceeded")) return;
    if (/context length|maximum context|token limit|too long|exceeds.*context/i.test(msg)) {
      return {
        message: { ...m, errorMessage: `context_length_exceeded: ${msg}` },
      };
    }
  });

  pi.registerCommand("free-router-status", {
    description: "Show Free Router gateway URL and provider pool",
    handler: async (_args, ctx) => {
      const stats = handle?.stats?.() ?? [];
      const lines = config.providers
        .filter((p) => p.enabled)
        .map((p: ProviderEntry) => {
          const s = stats.find((x) => x.id === p.id);
          const cool =
            s && s.cooling && s.until
              ? `  ❄ cooling ${Math.ceil((s.until - Date.now()) / 1000)}s`
              : "";
          return `• ${p.piModel}  →  ${p.label}  [${p.model}]  tools:${p.supportsTools ? "yes" : "no"}${cool}`;
        });
      const body =
        `Free Router @ http://127.0.0.1:${port}/v1\n` +
        `strategy: ${config.strategy}\n` +
        `config: ${CONFIG_PATH}\n` +
        lines.join("\n");
      ctx.ui?.notify?.(body, "info");
    },
  });
}
