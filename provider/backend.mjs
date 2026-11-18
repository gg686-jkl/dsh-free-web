/**
 * The contract every search backend implements, the failure type they share, and the small
 * HTTP helpers they use.
 *
 * A backend is a plain object:
 *
 *   {
 *     id: 'tinyfish',                 // stable id, used in configuration
 *     title: 'TinyFish',              // shown in logs and diagnostics
 *     trust: 0.95,                    // ranking weight, measured with `probe.mjs --bench`
 *     available(settings): boolean,   // can this backend run right now?
 *     search({ query, maxResults, signal, settings }): Promise<Source[]>
 *   }
 *
 * `Source` is the shape dsh's `ctx.web` seam expects:
 *   { url, title?, snippet?, publishedAt? }
 *
 * Backends never throw for an empty result set — an empty array means "answered, nothing
 * found". They throw a `SearchFailure` for anything the caller should report, with a `kind`
 * the retry and breaker logic can act on.
 */

/** Kinds a caller can act on without parsing prose. */
export const FAILURE = {
  rateLimit: 'rate-limit',
  quota: 'quota',
  auth: 'auth',
  server: 'server',
  network: 'network',
  timeout: 'timeout',
  protocol: 'protocol',
  config: 'config',
}

export class SearchFailure extends Error {
  constructor(backend, message, { kind = FAILURE.server, status, cause } = {}) {
    super(`${backend}: ${message}`)
    this.name = 'SearchFailure'
    this.backend = backend
    this.kind = kind
    this.status = status
    this.cause = cause
  }

  /**
   * Whether an immediate second attempt could plausibly succeed. A rate limit is not one:
   * free tiers throttle for a window, so retrying spends latency to earn the same 429. The
   * breaker takes those backends out for a while instead.
   */
  get retryable() {
    return this.kind === FAILURE.server || this.kind === FAILURE.network
  }
}

/** The one timeout helper: combines the caller's signal with a per-request deadline. */
export function deadline(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** JSON request with a readable error for every outcome that is not "here is your body". */
export async function requestJson(url, init, signal, timeoutMs, backend) {
  let response
  try {
    response = await fetch(url, { ...init, signal: deadline(signal, timeoutMs) })
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new SearchFailure(backend, `timed out after ${timeoutMs}ms`, { kind: FAILURE.timeout, cause: error })
    }
    if (error?.name === 'AbortError') throw new SearchFailure(backend, 'cancelled', { kind: FAILURE.timeout, cause: error })
    throw new SearchFailure(backend, String(error?.message || error), { kind: FAILURE.network, cause: error })
  }
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch (error) {
    throw new SearchFailure(backend, `unparseable response (HTTP ${response.status})`, {
      kind: FAILURE.protocol,
      status: response.status,
      cause: error,
    })
  }
  if (!response.ok) throw failureFor(backend, response.status, data)
  return data
}

/**
 * Turn an HTTP failure into a typed one.
 *
 * Provider bodies are deliberately not echoed for 401/402/403: at least one anonymous tier
 * answers 402 with a freshly generated account and password in the body, and this text ends
 * up in logs and, worse, in the model's context. The status and a short reason are enough.
 */
export function failureFor(backend, status, data) {
  const detail = status >= 400 && status < 500 && [401, 402, 403].includes(status) ? '' : shortDetail(data)
  const suffix = detail ? `: ${detail}` : ''
  if (status === 401 || status === 403) {
    return new SearchFailure(backend, `rejected the credential (HTTP ${status})`, { kind: FAILURE.auth, status })
  }
  if (status === 402) return new SearchFailure(backend, `quota exhausted (HTTP 402)`, { kind: FAILURE.quota, status })
  if (status === 429) {
    return new SearchFailure(backend, `rate limited (HTTP 429)${suffix}`, { kind: FAILURE.rateLimit, status })
  }
  if (status >= 500) return new SearchFailure(backend, `unavailable (HTTP ${status})${suffix}`, { kind: FAILURE.server, status })
  return new SearchFailure(backend, `request failed (HTTP ${status})${suffix}`, { kind: FAILURE.server, status })
}

function shortDetail(data) {
  const value = data?.error?.message || data?.message || data?.detail
  return typeof value === 'string' ? value.slice(0, 200) : ''
}

/** Keep only usable http(s) sources; a URL with credentials is dropped rather than passed on. */
export function toSources(rows, { url, title, snippet, date } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const out = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const rawUrl = row[url || 'url']
    if (typeof rawUrl !== 'string' || !rawUrl) continue
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      continue
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue
    const titleText = str(row[title || 'title'])
    const snippetText = str(row[snippet || 'snippet'])
    const dateText = str(row[date || 'publishedAt'])
    out.push({
      url: parsed.href,
      ...(titleText ? { title: titleText } : {}),
      ...(snippetText ? { snippet: snippetText } : {}),
      ...(dateText ? { publishedAt: dateText } : {}),
    })
  }
  return out
}

function str(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}
