/**
 * Circuit Breaker — ported from OmniRoute's FASE-04 resilience architecture.
 *
 * States: CLOSED → DEGRADED → OPEN → HALF_OPEN → CLOSED
 * - Kind-aware thresholds: rate_limit vs quota_exhausted vs transient
 * - Exponential backoff on repeated open cycles
 * - Degraded warnings before full open
 * - Zero native deps (pure TS)
 */

export type FailureKind = "rate_limit" | "quota_exhausted" | "transient";

export const STATE = {
  CLOSED: "CLOSED",
  DEGRADED: "DEGRADED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
} as const;

type CircuitState = (typeof STATE)[keyof typeof STATE];

export interface CircuitBreakerOptions {
  /** Failure count to open the circuit (default: 5) */
  failureThreshold?: number;
  /** Base cooldown in ms before probing (default: 30000) */
  resetTimeout?: number;
  /** How many probe requests to allow in HALF_OPEN (default: 1) */
  halfOpenRequests?: number;
  /** Called on every state transition */
  onStateChange?: (name: string, from: string, to: string, reason?: string) => void;
  /** Custom failure classifier — return false to not count as a failure */
  isFailure?: (error: unknown) => boolean;
  /** Per-failure-kind cooldown overrides (ms) */
  cooldownByKind?: Partial<Record<FailureKind, number>>;
  /** Classify an error into a FailureKind */
  classifyError?: (error: unknown) => FailureKind | undefined;
  /** Per-kind thresholds */
  kindThresholds?: Partial<Record<FailureKind, { threshold: number; immediateOpen?: boolean }>>;
  /** Max backoff multiplier (default: 16x resetTimeout) */
  maxBackoffMultiplier?: number;
  /** How many open cycles before backoff escalates (default: 3) */
  backoffEscalationCount?: number;
}

interface TransitionRecord {
  from: string;
  to: string;
  timestamp: number;
  failureCount: number;
  reason?: string;
}

/** Error thrown when circuit is OPEN and refusing requests. */
export class CircuitBreakerOpenError extends Error {
  circuitName: string;
  retryAfterMs: number;
  constructor(message: string, circuitName: string, retryAfterMs: number) {
    super(message);
    this.name = "CircuitBreakerOpenError";
    this.circuitName = circuitName;
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  name: string;
  failureThreshold: number;
  resetTimeout: number;
  halfOpenRequests: number;
  onStateChange: ((name: string, from: string, to: string, reason?: string) => void) | null;
  isFailure: (error: unknown) => boolean;
  classifyError: ((error: unknown) => FailureKind | undefined) | null;
  cooldownByKind: Partial<Record<FailureKind, number>>;
  kindThresholds: Required<CircuitBreakerOptions>["kindThresholds"];

  state: CircuitState = STATE.CLOSED;
  failureCount = 0;
  successCount = 0;
  lastFailureTime: number | null = null;
  lastFailureKind: FailureKind | null = null;
  halfOpenAllowed = 0;
  maxBackoffMultiplier: number;
  backoffEscalationCount: number;

  kindFailureCounts: Record<string, number> = {};
  openCycleCount = 0;
  transitionHistory: TransitionRecord[] = [];
  maxTransitionHistory = 20;

  constructor(name: string, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 30_000;
    this.halfOpenRequests = options.halfOpenRequests ?? 1;
    this.onStateChange = options.onStateChange ?? null;
    this.isFailure = options.isFailure ?? (() => true);
    this.classifyError = options.classifyError ?? null;
    this.cooldownByKind = options.cooldownByKind ?? {};
    this.kindThresholds = options.kindThresholds ?? {};
    this.maxBackoffMultiplier = options.maxBackoffMultiplier ?? 16;
    this.backoffEscalationCount = options.backoffEscalationCount ?? 3;
  }

  /** Attempt to execute a function under circuit breaker protection. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this._refreshOpenState();

    if (this.state === STATE.OPEN) {
      throw new CircuitBreakerOpenError(
        `Circuit breaker "${this.name}" is OPEN. Try again later.`,
        this.name,
        this._timeUntilReset()
      );
    }

    if (this.state === STATE.HALF_OPEN && this.halfOpenAllowed <= 0) {
      throw new CircuitBreakerOpenError(
        `Circuit breaker "${this.name}" is HALF_OPEN, no more probes allowed.`,
        this.name,
        this._timeUntilReset()
      );
    }

    if (this.state === STATE.HALF_OPEN) this.halfOpenAllowed--;

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      if (this.isFailure(error)) {
        const kind = this.classifyError ? this.classifyError(error) : undefined;
        this._onFailure(kind);
      }
      throw error;
    }
  }

  /** Check if requests can be executed without throwing. */
  canExecute(): boolean {
    this._refreshOpenState();
    if (this.state === STATE.CLOSED || this.state === STATE.DEGRADED) return true;
    if (this.state === STATE.OPEN) return false;
    return this.state === STATE.HALF_OPEN && this.halfOpenAllowed > 0;
  }

  /** Get full breaker status. */
  getStatus() {
    this._refreshOpenState();
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastFailureKind: this.lastFailureKind,
      retryAfterMs: this._timeUntilReset(),
      openCycleCount: this.openCycleCount,
      kindFailureCounts: { ...this.kindFailureCounts },
      effectiveResetTimeout: this._effectiveResetTimeout(),
    };
  }

  /** Reset to CLOSED. */
  reset() {
    this._transition(STATE.CLOSED, "manual-reset");
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastFailureKind = null;
    this.openCycleCount = 0;
    this.kindFailureCounts = {};
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private _onSuccess() {
    if (this.state === STATE.OPEN || this.state === STATE.HALF_OPEN) {
      this._transition(STATE.CLOSED, this.state === STATE.HALF_OPEN ? "probe-success" : "success-recovery");
      this.failureCount = 0;
      this.successCount = 0;
      this.lastFailureKind = null;
      this.openCycleCount = 0;
      this.kindFailureCounts = {};
    } else {
      // CLOSED or DEGRADED: gradual recovery
      this.failureCount = Math.max(0, this.failureCount - 1);
      if (this.state === STATE.DEGRADED && this.failureCount <= Math.ceil(this.failureThreshold * 0.6)) {
        this._transition(STATE.CLOSED, "recovery");
      }
    }
  }

  private _onFailure(kind?: FailureKind | null) {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.lastFailureKind = kind ?? null;

    if (kind) {
      this.kindFailureCounts[kind] = (this.kindFailureCounts[kind] || 0) + 1;
      // Kind-specific threshold
      const kc = this.kindThresholds[kind];
      if (kc) {
        const kCount = this.kindFailureCounts[kind];
        if (kc.immediateOpen && kCount >= (kc.threshold || 1)) {
          this._openCircuit(kind);
          return;
        }
        if (kCount >= (kc.threshold || this.failureThreshold)) {
          this._openCircuit(kind);
          return;
        }
      }
    }

    if (this.state === STATE.OPEN) {
      // Already open — stay open
    } else if (this.state === STATE.HALF_OPEN) {
      this.openCycleCount++;
      this._transition(STATE.OPEN, `probe-failed (cycle ${this.openCycleCount})`);
    } else if (this.failureCount >= this.failureThreshold) {
      this._openCircuit(kind);
    } else if (this.failureCount >= Math.ceil(this.failureThreshold * 0.6)) {
      this._transition(STATE.DEGRADED, `elevated-failures (${this.failureCount}/${this.failureThreshold})`);
    }
  }

  private _openCircuit(kind: FailureKind | null) {
    this._transition(STATE.OPEN, kind ? `kind:${kind}` : undefined);
  }

  private _shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return true;
    return Date.now() - this.lastFailureTime >= this._effectiveCooldown();
  }

  private _effectiveCooldown(): number {
    const base = this._effectiveResetTimeout();
    if (this.lastFailureKind) {
      const override = this.cooldownByKind[this.lastFailureKind];
      if (typeof override === "number" && override >= 0) return override;
    }
    return base;
  }

  private _effectiveResetTimeout(): number {
    if (this.openCycleCount <= this.backoffEscalationCount) return this.resetTimeout;
    const factor = Math.pow(2, this.openCycleCount - this.backoffEscalationCount);
    return Math.min(this.resetTimeout * factor, this.resetTimeout * this.maxBackoffMultiplier);
  }

  private _timeUntilReset(): number {
    if (!this.lastFailureTime) return 0;
    return Math.max(0, this._effectiveCooldown() - (Date.now() - this.lastFailureTime));
  }

  private _refreshOpenState() {
    if (this.state === STATE.OPEN && this._shouldAttemptReset()) {
      this._transition(STATE.HALF_OPEN, "timeout-elapsed");
    }
  }

  private _transition(newState: CircuitState, reason?: string) {
    const old = this.state;
    this.state = newState;
    if (newState === STATE.HALF_OPEN) this.halfOpenAllowed = this.halfOpenRequests;

    this.transitionHistory.push({
      from: old,
      to: newState,
      timestamp: Date.now(),
      failureCount: this.failureCount,
      reason,
    });
    if (this.transitionHistory.length > this.maxTransitionHistory) this.transitionHistory.shift();

    if (this.onStateChange && old !== newState) {
      this.onStateChange(this.name, old, newState, reason);
    }
  }
}

// ─── Registry ───────────────────────────────────────────────────────────────
const registry = new Map<string, CircuitBreaker>();
const MAX_REGISTRY = 200;

/** Sweep idle CLOSED breakers every 5 min. */
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [name, cb] of registry) {
    const s = cb.getStatus();
    if (s.state === STATE.CLOSED && s.failureCount === 0 && (!s.lastFailureTime || now - s.lastFailureTime > 30 * 60_000)) {
      registry.delete(name);
    }
  }
}, 5 * 60_000);
if (typeof sweep === "object" && "unref" in sweep) (sweep as any).unref?.();

export function getCircuitBreaker(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
  if (!registry.has(name)) {
    if (registry.size >= MAX_REGISTRY) {
      // Evict oldest idle CLOSED breaker
      let oldest: string | null = null;
      let oldestTime = Infinity;
      for (const [n, cb] of registry) {
        const s = cb.getStatus();
        if (s.state === STATE.CLOSED && s.failureCount === 0) {
          const t = s.lastFailureTime || 0;
          if (t < oldestTime) { oldestTime = t; oldest = n; }
        }
      }
      if (oldest) registry.delete(oldest);
    }
    registry.set(name, new CircuitBreaker(name, options));
  }
  return registry.get(name)!;
}

export function getAllCircuitBreakerStatuses() {
  return Array.from(registry.values()).map((cb) => cb.getStatus());
}

export function resetAllCircuitBreakers() {
  for (const cb of registry.values()) cb.reset();
  registry.clear();
}
