import { FAILURE, SearchFailure } from './backend.mjs'

/**
 * Three small mechanisms that keep a free-tier search reliable.
 *
 * They are separate from the backends so every backend gets them for free, and they hold no
 * state that survives the process — a restart is a clean slate, which is the right default
 * for a coding session.
 */

/**
 * Stops calling a backend that keeps failing.
 *
 * Anonymous tiers answer 402 when a daily quota is gone and 429 when a minute is. Without a
 * breaker every search repeats the same doomed request, which costs seconds of latency for a
 * result that cannot arrive. Three consecutive failures open the circuit for a minute.
 */
export class Breaker {
  constructor({ threshold = 3, cooldownMs = 60_000, now = () => Date.now() } = {}) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.now = now
    this.state = new Map()
  }

  /** Whether this backend may be called at all right now. */
  allows(id) {
    const entry = this.state.get(id)
    if (!entry) return true
    if (entry.openUntil === 0) return true
    if (this.now() >= entry.openUntil) {
      // Half-open: the next call decides whether the circuit closes again.
      entry.openUntil = 0
      entry.failures = 0
      return true
    }
    return false
  }

  success(id) {
    this.state.set(id, { failures: 0, openUntil: 0 })
  }

  /** @param immediate - a 429 or a spent quota will not clear by trying again in a moment. */
  failure(id, immediate = false) {
    const entry = this.state.get(id) ?? { failures: 0, openUntil: 0 }
    entry.failures = immediate ? this.threshold : entry.failures + 1
    if (entry.failures >= this.threshold) entry.openUntil = this.now() + this.cooldownMs
    this.state.set(id, entry)
    return entry.openUntil > 0
  }

  /** For diagnostics: which backends are currently skipped. */
  open() {
    return [...this.state].filter(([, entry]) => entry.openUntil > this.now()).map(([id]) => id)
  }
}

/** A bounded, time-limited map from query to result. Failures are never cached. */
export class Cache {
  constructor({ ttlMs = 300_000, entries = 200, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs
    this.entries = entries
    this.now = now
    this.map = new Map()
  }

  get(key) {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (this.now() >= hit.expires) {
      this.map.delete(key)
      return undefined
    }
    // Refresh recency so the bound evicts the least recently used entry.
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key, value) {
    if (this.map.size >= this.entries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, { value, expires: this.now() + this.ttlMs })
  }

  get size() {
    return this.map.size
  }

  clear() {
    this.map.clear()
  }
}

/**
 * One retry for a failure that is worth retrying: a rate limit or a transient 5xx.
 *
 * Successes never pay for it, and a retry that would land outside the caller's deadline is
 * skipped rather than allowed to eat the budget.
 */
export async function withRetry(run, { attempts = 2, delayMs = 300, signal } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      const retryable = error instanceof SearchFailure && error.retryable
      if (!retryable || attempt === attempts - 1 || signal?.aborted) throw error
      await sleep(delayMs + Math.floor(Math.random() * 200), signal)
    }
  }
  throw lastError
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new SearchFailure('retry', 'cancelled during retry delay', { kind: FAILURE.timeout }))
      },
      { once: true },
    )
  })
}
