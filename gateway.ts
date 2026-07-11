/**
 * Free Router gateway — ported patterns from OmniRoute.
 *
 * What makes it work:
 * 1. Pluggable routing strategies (priority / round-robin / random / cost / latency / lkgp)
 * 2. Circuit breaker per provider (CLOSED→DEGRADED→OPEN→HALF_OPEN with kind-aware cooldown)
 * 3. Retry-After aware cooldown (respects upstream Retry-After headers)
 * 4. Combo system — multiple models chained with fallback, plus "auto" virtual combo
 * 5. Global fallback — last-resort provider when all others fail
 * 6. SSE pass-through streaming (true pass-through instead of buffered re-emission)
 * 7. Health / stats endpoints (provider status, circuit breaker states, resilience traces)
 * 8. Zero native deps — pure node:http + fetch
 */

import http from "node:http";
import { getCircuitBreaker, getAllCircuitBreakerStatuses, CircuitBreakerOpenError, type FailureKind } from "./circuit-breaker";
import { route, listStrategies, type RoutingContext } from "./routing";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ProviderEntry {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  piModel: string;
  contextWindow: number;
  maxTokens: number;
  supportsTools: boolean;
  enabled: boolean;
  /** Optional: cost per 1M tokens (USD) for cost-based routing. */
  costPer1MTokens?: number;
  /** Optional: average end-to-end latency (ms) for latency-based routing. */
  avgE2ELatencyMs?: number;
  /** Optional: free tier metadata (from OmniRoute catalog). */
  freeTierNotes?: string;
  /** Optional: provider category (free, api-key, oauth, etc.). */
  category?: string;
}

export type Strategy = "priority" | "round-robin" | "random" | "cost" | "latency" | "lkgp";

/** A combo is a named group of providers tried in sequence. */
export interface ComboEntry {
  name: string;
  /** Provider IDs in the order they should be tried. */
  providerIds: string[];
  /** Strategy for ordering within this combo. */
  strategy: Strategy;
  /** If true, auto-select best provider based on strategy. */
  autoSelect?: boolean;
}

export interface GatewayConfig {
  port: number;
  strategy: Strategy;
  cooldownMs?: number;
  /** Per-failure-kind cooldown overrides (ms) — OmniRoute pattern. */
  cooldownByKind?: Partial<Record<FailureKind, number>>;
  /** Circuit breaker failure threshold (OmniRoute pattern). */
  circuitBreakerThreshold?: number;
  /** Provider entries. */
  providers: ProviderEntry[];
  /** Named combos (OmniRoute combo system). */
  combos?: ComboEntry[];
  /** Global fallback provider ID — OmniRoute pattern. */
  globalFallbackProvider?: string;
  /** How often (ms) to refresh provider health. Default: 60000. */
  healthCheckIntervalMs?: number;
}

export interface ProviderStat {
  id: string;
  label: string;
  enabled: boolean;
  cooling: boolean;
  until: number | null;
  circuitBreakerState: string;
  circuitBreakerFailures: number;
  lastFailureKind: string | null;
  retryAfterMs: number;
}

export interface GatewayHandle {
  port: number;
  close(): void;
  stats(): ProviderStat[];
  resetBreaker(providerId: string): void;
  /** Which provider succeeded last (for LKGP strategy). */
  lastKnownGoodProvider: string | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function chatUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/chat/completions";
}

/** Parse Retry-After header (seconds or HTTP-date). */
function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;
  const parsed = new Date(value).getTime();
  return isFinite(parsed) ? Math.max(parsed - Date.now(), 0) : null;
}

/** Classify an HTTP error into a FailureKind. */
function classifyHttpError(status: number, body?: any): FailureKind | undefined {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "quota_exhausted";
  if (status >= 500) return "transient";
  if (body?.error?.type === "insufficient_quota") return "quota_exhausted";
  if (body?.error?.type === "rate_limit_exceeded") return "rate_limit";
  return undefined;
}

/** Decide if an error from fetch should count as a failure. */
function isFailure(error: unknown): boolean {
  if (!error) return true;
  if (error instanceof CircuitBreakerOpenError) return false; // own breaker, not upstream
  const msg = typeof error === "string" ? error : (error as any)?.message || "";
  // Don't count local stream lifecycle errors
  if (/controller is already closed/i.test(msg)) return false;
  return true;
}

// ─── Gateway Creator ────────────────────────────────────────────────────────

export function createGateway(config: GatewayConfig) {
  const enabled = () => config.providers.filter((p) => p.enabled);
  const byPiModel = new Map<string, ProviderEntry>();
  for (const p of enabled()) byPiModel.set(p.piModel, p);

  const cooldownMs = config.cooldownMs ?? 60_000;
  const cooldownUntil = new Map<string, number>();
  const cooldownReason = new Map<string, string>();

  let server: http.Server | null = null;
  let lastKnownGoodProvider: string | null = null;

  // Track per-provider failure counts for Retry-After awareness
  const providerFailures = new Map<string, { count: number; lastRetryAfter: number | null }>();

  // ─── Cooldown helpers ─────────────────────────────────────────────────

  const isCooling = (id: string): boolean => {
    const until = cooldownUntil.get(id);
    return until !== undefined && until > Date.now();
  };

  const markCooled = (p: ProviderEntry, reason = "failure", retryAfterMs?: number) => {
    const ms = retryAfterMs ?? cooldownMs;
    cooldownUntil.set(p.id, Date.now() + ms);
    cooldownReason.set(p.id, reason);

    const f = providerFailures.get(p.id) || { count: 0, lastRetryAfter: null };
    f.count++;
    f.lastRetryAfter = retryAfterMs ?? null;
    providerFailures.set(p.id, f);

    // Also trip the circuit breaker
    getCircuitBreaker(p.id, {
      failureThreshold: config.circuitBreakerThreshold ?? 5,
      resetTimeout: cooldownMs,
      cooldownByKind: config.cooldownByKind,
    })._onFailure(classifyHttpError(0)); // generic failure
  };

  const recovered = (p: ProviderEntry) => {
    cooldownUntil.delete(p.id);
    cooldownReason.delete(p.id);
    providerFailures.delete(p.id);
    getCircuitBreaker(p.id)._onSuccess();
  };

  // ─── Stats ───────────────────────────────────────────────────────────

  function stats(): ProviderStat[] {
    const breakers = getAllCircuitBreakerStatuses();
    return config.providers.map((p) => {
      const until = cooldownUntil.get(p.id) ?? null;
      const cb = breakers.find((b) => b.name === p.id);
      return {
        id: p.id,
        label: p.label,
        enabled: p.enabled,
        cooling: until !== null && until > Date.now(),
        until,
        circuitBreakerState: cb?.state ?? "CLOSED",
        circuitBreakerFailures: cb?.failureCount ?? 0,
        lastFailureKind: cb?.lastFailureKind ?? null,
        retryAfterMs: cb?.retryAfterMs ?? 0,
      };
    });
  }

  // ─── Build candidate list ────────────────────────────────────────────

  function buildCandidates(piModel: string, wantsTools: boolean): ProviderEntry[] {
    let pool = enabled();

    // If a specific piModel was requested, try to find it
    const requested = byPiModel.get(piModel);

    // If "fr-auto", use strategy to order all providers
    // If a specific model, try it first
    const ctx: RoutingContext = {
      requestedPiModel: piModel,
      wantsTools,
      lastKnownGoodProvider: lastKnownGoodProvider ?? undefined,
    };

    // If requesting a specific provider model (not auto), prioritize it
    if (requested) {
      const decision = route(pool, ctx, config.strategy);
      const candidates = decision.candidates.map((c) => c.provider);
      // But make sure the requested one is first
      const withRequested = [requested, ...candidates.filter((p) => p !== requested)];
      return withRequested;
    }

    // For "fr-auto" or unknown model, use the strategy-based routing
    const decision = route(pool, ctx, config.strategy);
    return decision.candidates.map((c) => c.provider);
  }

  // ─── Combo resolution ────────────────────────────────────────────────

  function resolveCombo(providerIds: string[]): ProviderEntry[] {
    const pool = enabled();
    const map = new Map(pool.map((p) => [p.id, p]));
    return providerIds.map((id) => map.get(id)).filter((p): p is ProviderEntry => !!p);
  }

  function isComboModel(piModel: string): ComboEntry | undefined {
    return config.combos?.find((c) => c.name === piModel);
  }

  // ─── HTTP Handler ────────────────────────────────────────────────────

  async function handleChat(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    raw: string,
  ) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json body" }));
      return;
    }

    // Early validation — OmniRoute pattern
    const b = parsed as { temperature?: unknown; top_p?: unknown; max_tokens?: unknown; n?: unknown; messages?: unknown; model?: unknown };
    if (b.temperature !== undefined && (typeof b.temperature !== "number" || b.temperature < 0 || b.temperature > 2)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "temperature must be a number between 0 and 2" }));
      return;
    }
    if (b.max_tokens !== undefined && (typeof b.max_tokens !== "number" || !Number.isInteger(b.max_tokens) || b.max_tokens < 1)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "max_tokens must be a positive integer" }));
      return;
    }
    if (Array.isArray(b.messages) && b.messages.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "messages: at least one message is required" }));
      return;
    }

    const wantsTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    const rawModel = parsed.model || "fr-auto";
    const piWantsStream = parsed.stream === true;

    // ── Combo resolution (OmniRoute pattern) ───────────────────────────
    let candidates: ProviderEntry[] = [];
    let comboName: string | null = null;

    const combo = isComboModel(rawModel);
    if (combo) {
      candidates = resolveCombo(combo.providerIds);
      comboName = combo.name;
    } else {
      candidates = buildCandidates(rawModel, wantsTools);
    }

    // Filter out OPEN circuit breakers
    const alive = candidates.filter((p) => {
      const cb = getCircuitBreaker(p.id);
      return cb.canExecute() || isCooling(p.id);
    });
    const usable = alive.filter((p) => !isCooling(p.id));
    const finalCandidates = usable.length > 0 ? usable : alive;
    // If everything is cooling but we have candidates, try them anyway
    // (they might recover)

    if (!finalCandidates.length) {
      // ── Global Fallback (OmniRoute pattern) ──────────────────────────
      if (config.globalFallbackProvider) {
        const gf = enabled().find((p) => p.id === config.globalFallbackProvider);
        if (gf) {
          finalCandidates.push(gf);
        }
      }
    }

    if (!finalCandidates.length) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no providers available for model "${rawModel}"` }));
      return;
    }

    // ── Try each candidate in order ───────────────────────────────────
    let lastError: string | null = null;
    const resilienceTrace: Array<{ event: string; provider: string; timestamp: string; status?: number }> = [];
    const startTime = Date.now();

    for (const prov of finalCandidates) {
      const cb = getCircuitBreaker(prov.id, {
        failureThreshold: config.circuitBreakerThreshold ?? 5,
        resetTimeout: config.cooldownMs ?? 60_000,
        cooldownByKind: config.cooldownByKind ?? { rate_limit: 60_000, quota_exhausted: 300_000 },
      });

      // Check circuit breaker before trying
      if (!cb.canExecute()) {
        resilienceTrace.push({
          event: "circuit_open",
          provider: prov.id,
          timestamp: new Date().toISOString(),
          status: 503,
        });
        lastError = `circuit breaker OPEN for ${prov.id}`;
        continue;
      }

      const upstreamBody: any = { ...parsed, model: prov.model, stream: false };
      if (!prov.supportsTools) {
        delete upstreamBody.tools;
        delete upstreamBody.tool_choice;
      }

      try {
        const fetchStart = Date.now();
        const r = await cb.execute(() =>
          fetch(chatUrl(prov.baseUrl), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(prov.apiKey ? { authorization: `Bearer ${prov.apiKey}` } : {}),
            },
            body: JSON.stringify(upstreamBody),
            signal: AbortSignal.timeout(30000),
          })
        );

        const latencyMs = Date.now() - fetchStart;

        // Handle non-ok responses
        if (!r.ok) {
          const retryAfter = parseRetryAfter(r.headers.get("retry-after"));
          const kind = classifyHttpError(r.status);
          const bodyText = await r.text().catch(() => "");
          let body: any;
          try { body = JSON.parse(bodyText); } catch { body = { error: bodyText }; }

          // Mark with Retry-Aware cooldown (OmniRoute pattern)
          if (retryAfter) {
            cooldownUntil.set(prov.id, Date.now() + retryAfter);
            cooldownReason.set(prov.id, `retry-after:${r.status}`);
          } else {
            const cooldown = kind === "rate_limit"
              ? (config.cooldownByKind?.rate_limit ?? cooldownMs)
              : kind === "quota_exhausted"
                ? (config.cooldownByKind?.quota_exhausted ?? cooldownMs * 5)
                : cooldownMs;
            markCooled(prov, `http_${r.status}`, cooldown);
          }

          resilienceTrace.push({
            event: `failed:${r.status}`,
            provider: prov.id,
            timestamp: new Date().toISOString(),
            status: r.status,
          });
          lastError = `HTTP ${r.status}: ${body?.error?.message || r.statusText}`;

          // Let the outer catch handle non-200s as retry
          if (r.status === 429 || r.status >= 500) continue;
          // For 4xx (other than 429), don't retry — return the error
          if (r.status >= 400 && r.status < 500) {
            res.writeHead(r.status, {
              "content-type": "application/json",
              "x-free-router-provider": prov.id,
              "x-free-router-latency-ms": String(latencyMs),
            });
            res.end(JSON.stringify(body));
            return;
          }
          continue;
        }

        // Success — recover the provider and update LKGP
        recovered(prov);
        lastKnownGoodProvider = prov.id;

        resilienceTrace.push({
          event: "success",
          provider: prov.id,
          timestamp: new Date().toISOString(),
          status: 200,
        });

        if (!piWantsStream) {
          const data = await r.json().catch(() => ({}));
          res.writeHead(200, {
            "content-type": "application/json",
            "x-free-router-provider": prov.id,
            "x-free-router-latency-ms": String(latencyMs),
          });
          // Inject resilience and routing metadata (OmniRoute pattern)
          data._resilience = {
            provider: prov.id,
            strategy: config.strategy,
            combo: comboName,
            latencyMs,
            fallbacksTriggered: resilienceTrace.length > 1,
            resilienceTrace,
          };
          res.end(JSON.stringify(data));
          return;
        }

        // ── SSE pass-through streaming ─────────────────────────────────
        // Try true streaming pass-through first; fall back to re-emission if needed
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-free-router-provider": prov.id,
          "x-free-router-latency-ms": String(latencyMs),
        });

        const bodyReader = r.body;
        if (bodyReader) {
          // True pass-through streaming
          const reader = bodyReader.getReader();
          const decoder = new TextDecoder();
          let done = false;
          while (!done) {
            const { value, done: d } = await reader.read();
            done = d;
            if (value) {
              const text = decoder.decode(value, { stream: true });
              res.write(text);
            }
          }
        } else {
          // Fallback: get text and re-emit
          const text = await r.text();
          res.write(text);
        }

        // Final [DONE] signal (OmniRoute adds this if upstream didn't)
        if (!res.writableEnded) {
          res.write("data: [DONE]\n\n");
          res.end();
        }
        return;
      } catch (err: any) {
        // Don't count CircuitBreakerOpenError as a failure (it's our own breaker)
        if (err instanceof CircuitBreakerOpenError) {
          resilienceTrace.push({
            event: "circuit_short-circuit",
            provider: prov.id,
            timestamp: new Date().toISOString(),
            status: 503,
          });
          lastError = err.message;
          continue;
        }

        // Count this as a failure (but not for local lifecycle errors)
        if (isFailure(err)) {
          markCooled(prov, err?.message?.slice(0, 100) || "network_error");
        }

        const isTimeout = err?.name === "TimeoutError" || err?.message?.includes("timed out");
        resilienceTrace.push({
          event: isTimeout ? "timeout" : "network_error",
          provider: prov.id,
          timestamp: new Date().toISOString(),
        });
        lastError = err?.message ?? "unknown error";
        continue;
      }
    }

    // ── All providers failed ──────────────────────────────────────────
    const totalMs = Date.now() - startTime;

    if (!res.headersSent) {
      res.writeHead(502, {
        "content-type": "application/json",
        "x-free-router-fallbacks": String(resilienceTrace.length),
      });
      res.end(JSON.stringify({
        error: `all providers failed (${resilienceTrace.length} attempts)`,
        _resilience: {
          lastError,
          fallbacksTriggered: resilienceTrace.length > 1,
          resilienceTrace,
          totalMs,
        },
      }));
    } else {
      res.end();
    }
  }

  // ─── Server ──────────────────────────────────────────────────────────────

  async function start(): Promise<GatewayHandle> {
    server = http.createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];

      // POST /v1/chat/completions
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => handleChat(req, res, body));
        return;
      }

      // GET /v1/models
      if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
        const data = enabled().map((p) => ({
          id: p.piModel,
          object: "model",
          created: 0,
          owned_by: "free-router",
          label: p.label,
          ...(p.freeTierNotes ? { free_tier_notes: p.freeTierNotes } : {}),
        }));

        // Include combo models
        if (config.combos) {
          for (const c of config.combos) {
            data.push({
              id: c.name,
              object: "model",
              created: 0,
              owned_by: "free-router",
              label: `Combo: ${c.name} (${c.providerIds.join(", ")})`,
            });
          }
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data }));
        return;
      }

      // GET /v1/stats — OmniRoute-style health endpoint
      if (req.method === "GET" && (url === "/v1/stats" || url === "/stats" || url === "/v1/health" || url === "/health")) {
        const providerStats = stats();
        const breakerStatuses = getAllCircuitBreakerStatuses();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          uptimeMs: Date.now() - startTime,
          cooldownMs,
          strategy: config.strategy,
          strategies: listStrategies(),
          lastKnownGoodProvider,
          providers: providerStats,
          circuitBreakers: breakerStatuses.map((cb) => ({
            name: cb.name,
            state: cb.state,
            failureCount: cb.failureCount,
            successCount: cb.successCount,
            retryAfterMs: cb.retryAfterMs,
            lastFailureKind: cb.lastFailureKind,
            openCycleCount: cb.openCycleCount,
          })),
          combos: config.combos ?? [],
          globalFallback: config.globalFallbackProvider ?? null,
        }));
        return;
      }

      // POST /v1/reset-breaker — manual circuit breaker reset
      if (req.method === "POST" && url === "/v1/reset-breaker") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const providerId = parsed.providerId;
            if (providerId) {
              getCircuitBreaker(providerId).reset();
              cooldownUntil.delete(providerId);
              cooldownReason.delete(providerId);
            } else {
              // Reset all
              const { resetAllCircuitBreakers } = require("./circuit-breaker");
              resetAllCircuitBreakers();
              cooldownUntil.clear();
              cooldownReason.clear();
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (e: any) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: e?.message || "invalid body" }));
          }
        });
        return;
      }

      // GET / — healthz
      if (url === "/" || url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("free-router ok");
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(config.port, "127.0.0.1", () => resolve());
    }).catch((err: any) => {
      if (err?.code === "EADDRINUSE") {
        // Another Pi session owns this port — that's fine
        return {
          port: config.port,
          close() {},
          stats: () => [],
          resetBreaker: (_id: string) => {},
          lastKnownGoodProvider: null as string | null,
        } as GatewayHandle;
      }
      throw err;
    });

    return {
      port: config.port,
      close() {
        try { server?.close(); } catch {}
        server = null;
      },
      stats,
      resetBreaker(providerId: string) {
        getCircuitBreaker(providerId).reset();
        cooldownUntil.delete(providerId);
        cooldownReason.delete(providerId);
      },
      get lastKnownGoodProvider() { return lastKnownGoodProvider; },
    };
  }

  return { start };
}
