/**
 * pi-free-router — Free-tier LLM API gateway for Pi.
 *
 * OmniRoute-style patterns ported to a pure-TypeScript Pi extension:
 *  - Pluggable routing strategies (priority / round-robin / random / cost / latency / lkgp)
 *  - Circuit breaker per provider (CLOSED→DEGRADED→OPEN→HALF_OPEN with kind-aware cooldown)
 *  - Retry-After aware cooldown
 *  - Combo system with virtual "auto" combo + named model chains
 *  - Global fallback (last-resort provider)
 *  - SSE pass-through streaming
 *  - Health / stats endpoints
 *  - Zero native deps
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGateway, type GatewayHandle, type ProviderEntry } from "./gateway";
import { loadConfig, CONFIG_PATH } from "./config";
import { listStrategies } from "./routing";
import { getCircuitBreaker, resetAllCircuitBreakers } from "./circuit-breaker";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const port = config.port || 8731;

  // ── Build model catalog ──────────────────────────────────────────────
  // Individual provider models
  const providerModels = config.providers
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

  // Combo models (OmniRoute pattern)
  const comboModels = (config.combos ?? []).map((c) => ({
    id: c.name,
    name: `Combo: ${c.name} [${c.strategy}] — ${c.providerIds.length > 0 ? c.providerIds.join(" → ") : "all enabled"}`,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  }));

  const models = [
    // Unified "fr-auto" — fans across ALL enabled providers
    {
      id: "fr-auto",
      name: "Free Router (auto — all available providers, OmniRoute-style)",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    },
    // Individual provider models
    ...providerModels,
    // Combo models
    ...comboModels,
  ];

  // ── Register Pi provider ─────────────────────────────────────────────
  pi.registerProvider("free-router", {
    name: "Free Router",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "not-needed",
    api: "openai-completions",
    models,
  });

  let handle: GatewayHandle | null = null;

  // ── Lifecycle hooks ──────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    if (handle) return;
    try {
      handle = await createGateway(config).start();
      ctx.ui?.notify?.(
        `Free Router gateway listening on 127.0.0.1:${port}\n` +
        `${models.length} models, ${config.providers.filter((p) => p.enabled).length} providers enabled, ` +
        `${(config.combos ?? []).length} combos. ` +
        `Strategies: ${listStrategies().map((s) => s.name).join(", ")}`,
        "info",
      );
    } catch (err: any) {
      ctx.ui?.notify?.(
        `Free Router gateway failed: ${err?.message ?? err}. ` +
        `Try: kill any other Pi sessions using port ${port}, then /reload`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", () => {
    try { handle?.close(); } catch {}
    handle = null;
  });

  // ── Context overflow normalization (OmniRoute pattern) ─────────────
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

  // ── Commands ────────────────────────────────────────────────────────

  pi.registerCommand("free-router-status", {
    description: "Show Free Router gateway status, provider pool, and circuit breakers",
    handler: async (_args, ctx) => {
      const stats = handle?.stats?.() ?? [];
      const lines: string[] = [];

      // Gateway info
      lines.push(`🔄 Free Router @ http://127.0.0.1:${port}/v1`);
      lines.push(`📋 Config: ${CONFIG_PATH}`);
      lines.push(`🎯 Strategy: ${config.strategy}`);
      lines.push(`🧠 Last good: ${handle?.lastKnownGoodProvider ?? "none"}`);
      lines.push(`🛡️  Global fallback: ${config.globalFallbackProvider ?? "none"}`);
      lines.push("");

      // Providers
      const enabled = config.providers.filter((p) => p.enabled);
      lines.push(`📡 Providers (${enabled.length} enabled, ${config.providers.length} total):`);
      for (const p of enabled) {
        const s = stats.find((x) => x.id === p.id);
        const cbState = s?.circuitBreakerState ?? "CLOSED";
        const cbIcon = cbState === "CLOSED" ? "✅" : cbState === "DEGRADED" ? "⚠️" : cbState === "HALF_OPEN" ? "🔄" : "❌";
        const cool = s?.cooling
          ? ` ❄ cooldown ${Math.ceil(((s.until ?? 0) - Date.now()) / 1000)}s`
          : "";
        lines.push(`  ${cbIcon} ${p.piModel}  →  ${p.label} [${p.model}] tools:${p.supportsTools ? "yes" : "no"}${cool} (${cbState})`);
      }

      // Combos
      const combos = config.combos ?? [];
      if (combos.length > 0) {
        lines.push("");
        lines.push(`🔗 Combos (${combos.length}):`);
        for (const c of combos) {
          lines.push(`  • ${c.name} [${c.strategy}]: ${c.providerIds.length > 0 ? c.providerIds.join(" → ") : "all enabled"}${c.autoSelect ? " (auto)" : ""}`);
        }
      }

      // Circuit breakers in non-CLOSED state
      const openBreakers = stats.filter((s) => s.circuitBreakerState !== "CLOSED");
      if (openBreakers.length > 0) {
        lines.push("");
        lines.push(`⚡ Active circuit breakers:`);
        for (const s of openBreakers) {
          lines.push(`  • ${s.id}: ${s.circuitBreakerState} (failures: ${s.circuitBreakerFailures}, retry in ${Math.ceil(s.retryAfterMs / 1000)}s)`);
        }
      }

      lines.push("");
      lines.push(`Available strategies: ${listStrategies().map((s) => s.name).join(", ")}`);
      lines.push(`Use /free-router-strategy <name> to switch.`);
      lines.push(`Use /free-router-reset <providerId> to reset a circuit breaker.`);

      ctx.ui?.notify?.(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("free-router-strategy", {
    description: "Switch routing strategy (priority, round-robin, random, cost, latency, lkgp)",
    handler: async (args, ctx) => {
      const name = args?.[0];
      if (!name) {
        const available = listStrategies().map((s) => s.name).join(", ");
        ctx.ui?.notify?.(`Current strategy: ${config.strategy}. Available: ${available}`, "info");
        return;
      }
      const valid = listStrategies().find((s) => s.name === name);
      if (!valid) {
        ctx.ui?.notify?.(`Unknown strategy "${name}". Available: ${listStrategies().map((s) => s.name).join(", ")}`, "error");
        return;
      }
      config.strategy = name as any;
      ctx.ui?.notify?.(`🔄 Routing strategy switched to "${name}". Reload to persist.`, "info");
    },
  });

  pi.registerCommand("free-router-reset", {
    description: "Reset circuit breaker for a provider (or 'all'). Usage: /free-router-reset <providerId|all>",
    handler: async (args, ctx) => {
      const id = args?.[0];
      if (!id) {
        ctx.ui?.notify?.("Usage: /free-router-reset <providerId|all>", "info");
        return;
      }
      if (id === "all") {
        resetAllCircuitBreakers();
        ctx.ui?.notify?.("✅ All circuit breakers reset", "info");
        return;
      }
      const breaker = getCircuitBreaker(id);
      breaker.reset();
      handle?.resetBreaker?.(id);
      ctx.ui?.notify?.(`✅ Circuit breaker for "${id}" reset`, "info");
    },
  });

  pi.registerCommand("free-router-reload", {
    description: "Reload config from disk (reads free-router.json again)",
    handler: async (_args, ctx) => {
      try {
        // Shutdown old gateway
        handle?.close();
        handle = null;
        // Reload config
        const newConfig = loadConfig();
        Object.assign(config, newConfig);
        handle = await createGateway(config).start();
        ctx.ui?.notify?.(
          `✅ Free Router reloaded: ${config.providers.filter((p) => p.enabled).length} providers, ` +
          `${(config.combos ?? []).length} combos, strategy=${config.strategy}`,
          "info",
        );
      } catch (err: any) {
        ctx.ui?.notify?.(`❌ Reload failed: ${err?.message ?? err}`, "error");
      }
    },
  });
}
