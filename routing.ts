/**
 * Pluggable Routing Strategies — ported from OmniRoute's RouterStrategy pattern.
 *
 * Built-in strategies:
 *   priority  — Requested provider first, then rest (default)
 *   round-robin — Cycle through providers evenly
 *   random   — Pick at random
 *   cost     — Prefer cheapest (by costPer1MTokens if available)
 *   latency  — Prefer lowest-p95-latency provider
 *   lkgp     — Last known good provider first
 *
 * Each strategy implements the RouterStrategy interface and is registered
 * in a strategy registry. Zero native deps.
 */

import type { ProviderEntry } from "./gateway";

/** Context available at routing time. */
export interface RoutingContext {
  /** The Pi-facing model ID the user requested (e.g. "fr-auto" or "fr-groq-70b"). */
  requestedPiModel: string;
  /** Does the request include tool calls? */
  wantsTools: boolean;
  /** The last provider that succeeded (for LKGP strategy). */
  lastKnownGoodProvider?: string;
}

/** A candidate provider with derived scores. */
export interface RoutingCandidate {
  provider: ProviderEntry;
  score: number;
  reason: string;
}

/** Result of routing. */
export interface RoutingDecision {
  /** Ordered list of candidates to try (first = highest priority). */
  candidates: RoutingCandidate[];
  /** Which strategy was used. */
  strategy: string;
}

export interface RouterStrategy {
  readonly name: string;
  readonly description: string;
  /** Given the pool and context, produce an ordered list of candidates. */
  route(pool: ProviderEntry[], ctx: RoutingContext): RoutingDecision;
}

// ─── Priority Strategy (default) ───────────────────────────────────────────

class PriorityStrategy implements RouterStrategy {
  readonly name = "priority";
  readonly description = "Requested provider first, then rest by config order";

  route(pool: ProviderEntry[], ctx: RoutingContext): RoutingDecision {
    const requested = pool.find((p) => p.piModel === ctx.requestedPiModel);
    const rest = requested ? pool.filter((p) => p !== requested) : pool;

    // Prefer tool-capable providers when tools are needed (unless a specific model was requested)
    const order = requested
      ? [requested, ...rest]
      : ctx.wantsTools
        ? [...pool.filter((p) => p.supportsTools), ...pool.filter((p) => !p.supportsTools)]
        : pool;

    return {
      strategy: this.name,
      candidates: order.map((p) => ({
        provider: p,
        score: p === requested ? 1 : 0.5,
        reason: p === requested ? "requested provider" : "fallback",
      })),
    };
  }
}

// ─── Round-Robin Strategy ─────────────────────────────────────────────────

class RoundRobinStrategy implements RouterStrategy {
  readonly name = "round-robin";
  readonly description = "Cycle through providers evenly";

  private counter = 0;

  route(pool: ProviderEntry[], ctx: RoutingContext): RoutingDecision {
    if (pool.length === 0) return { strategy: this.name, candidates: [] };
    const start = this.counter++ % pool.length;
    const ordered = [...pool.slice(start), ...pool.slice(0, start)];

    // Reorder so tool-capable come first if tools needed
    const finalOrder = ctx.wantsTools
      ? [...ordered.filter((p) => p.supportsTools), ...ordered.filter((p) => !p.supportsTools)]
      : ordered;

    return {
      strategy: this.name,
      candidates: finalOrder.map((p, i) => ({
        provider: p,
        score: 1 - i / finalOrder.length,
        reason: i === 0 ? "round-robin pick" : "fallback",
      })),
    };
  }
}

// ─── Random Strategy ──────────────────────────────────────────────────────

class RandomStrategy implements RouterStrategy {
  readonly name = "random";
  readonly description = "Pick a random provider, then fallback";

  route(pool: ProviderEntry[], ctx: RoutingContext): RoutingDecision {
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const ordered = ctx.wantsTools
      ? [...shuffled.filter((p) => p.supportsTools), ...shuffled.filter((p) => !p.supportsTools)]
      : shuffled;

    return {
      strategy: this.name,
      candidates: ordered.map((p, i) => ({
        provider: p,
        score: 1 - i / ordered.length,
        reason: i === 0 ? "random pick" : "fallback",
      })),
    };
  }
}

// ─── Cost Strategy ────────────────────────────────────────────────────────
// Prefers providers with lower costPer1MTokens. Falls back to priority order
// when cost data is unavailable.

class CostStrategy implements RouterStrategy {
  readonly name = "cost";
  readonly description = "Prefer cheapest provider by costPer1MTokens";

  route(pool: ProviderEntry[], ctx: RoutingContext): RoutingDecision {
    const withCost = pool
      .filter((p) => typeof (p as any).costPer1MTokens === "number")
      .sort((a, b) => (a as any).costPer1MTokens - (b as any).costPer1MTokens);
    const withoutCost = pool.filter((p) => typeof (p as any).costPer1MTokens !== "number");

    const ordered = ctx.wantsTools
      ? [...withCost.filter((p) => p.supportsTools), ...withCost.filter((p) => !p.supportsTools),
         ...withoutCost.filter((p) => p.supportsTools), ...withoutCost.filter((p) => !p.supportsTools)]
      : [...withCost, ...withoutCost];

    return {
      strategy: this.name,
      candidates: ordered.map((p, i) => ({
        provider: p,
        score: 1 - i / ordered.length,
        reason: typeof (p as any).costPer1MTokens === "number"
          ? `cost=$${(p as any).costPer1MTokens}/1M`
          : "no cost data",
      })),
    };
  }
}

// ─── Latency Strategy ─────────────────────────────────────────────────────
// Prefers providers with lower avgE2ELatencyMs. Falls back to priority.

class LatencyStrategy implements RouterStrategy {
  readonly name = "latency";
  readonly description = "Prefer fastest provider by avg latency";

  route(pool: ProviderEntry[], ctx: RoutingContext): RoutingDecision {
    const withLatency = pool
      .filter((p) => typeof (p as any).avgE2ELatencyMs === "number")
      .sort((a, b) => (a as any).avgE2ELatencyMs - (b as any).avgE2ELatencyMs);
    const withoutLatency = pool.filter((p) => typeof (p as any).avgE2ELatencyMs !== "number");

    const ordered = ctx.wantsTools
      ? [...withLatency.filter((p) => p.supportsTools), ...withLatency.filter((p) => !p.supportsTools),
         ...withoutLatency.filter((p) => p.supportsTools), ...withoutLatency.filter((p) => !p.supportsTools)]
      : [...withLatency, ...withoutLatency];

    return {
      strategy: this.name,
      candidates: ordered.map((p, i) => ({
        provider: p,
        score: 1 - i / ordered.length,
        reason: typeof (p as any).avgE2ELatencyMs === "number"
          ? `latency=${(p as any).avgE2ELatencyMs}ms`
          : "no latency data",
      })),
    };
  }
}

// ─── LKGP (Last Known Good Provider) Strategy ────────────────────────────

class LKGPStrategy implements RouterStrategy {
  readonly name = "lkgp";
  readonly description = "Try last known good provider first, then fallback to priority";

  route(pool: ProviderEntry[], ctx: RoutingContext): RoutingDecision {
    if (ctx.lastKnownGoodProvider) {
      const lkgp = pool.find((p) => p.id === ctx.lastKnownGoodProvider);
      if (lkgp) {
        const ordered = [lkgp, ...pool.filter((p) => p !== lkgp)];
        return {
          strategy: this.name,
          candidates: ordered.map((p) => ({
            provider: p,
            score: p === lkgp ? 1 : 0.5,
            reason: p === lkgp ? "last known good" : "fallback",
          })),
        };
      }
    }
    // Fallback to priority
    return new PriorityStrategy().route(pool, ctx);
  }
}

// ─── Strategy Registry ─────────────────────────────────────────────────────

const registry = new Map<string, RouterStrategy>();

const priority = new PriorityStrategy();
const roundRobin = new RoundRobinStrategy();
const random = new RandomStrategy();
const cost = new CostStrategy();
const latency = new LatencyStrategy();
const lkgp = new LKGPStrategy();

registry.set("priority", priority);
registry.set("round-robin", roundRobin);
registry.set("random", random);
registry.set("cost", cost);
registry.set("latency", latency);
registry.set("lkgp", lkgp);

/** Get a strategy by name. Falls back to "priority" if not found. */
export function getStrategy(name: string): RouterStrategy {
  return registry.get(name) ?? priority;
}

/** Register a custom strategy. */
export function registerStrategy(name: string, strategy: RouterStrategy): void {
  registry.set(name, strategy);
}

/** List all registered strategies. */
export function listStrategies(): Array<{ name: string; description: string }> {
  return [...registry.entries()].map(([name, s]) => ({ name, description: s.description }));
}

/** Shorthand: apply a named strategy to a pool. */
export function route(pool: ProviderEntry[], ctx: RoutingContext, strategyName = "priority"): RoutingDecision {
  return getStrategy(strategyName).route(pool, ctx);
}
