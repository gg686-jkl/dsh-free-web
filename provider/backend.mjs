/**
 * The contract every search backend implements, plus the small HTTP helpers they share.
 *
 * A backend is a plain object:
 *
 *   {
 *     id: 'tinyfish',                 // stable id, used in configuration
 *     title: 'TinyFish',              // shown in logs and diagnostics
 *     needsKey: true,                 // whether `available()` depends on a credential
 *     available(settings): boolean,   // can this backend run right now?
 *     search({ query, maxResults, signal, settings }): Promise<Source[]>
 *   }
 *
 * `Source` is the shape dsh's `ctx.web` seam expects:
 *   { url, title?, snippet?, publishedAt? }
 *
 * Backends never throw for an empty result set — an empty array means "answered, nothing
 * found". They throw a `SearchFailure` for anything the caller should report (network,
 * authentication, quota), so the orchestrator can name the reason.
 */

/** A failure a caller can report per backend without guessing what went wrong. */
export class SearchFailure extends Error {
  constructor(backend, message, cause) {
    super(`${backend}: ${message}`)
    this.name = 'SearchFailure'
    this.backend = backend
    this.cause = cause
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
    if (error?.name === 'TimeoutError') throw new SearchFailure(backend, `timed out after ${timeoutMs}ms`, error)
    if (error?.name === 'AbortError') throw new SearchFailure(backend, 'cancelled', error)
    throw new SearchFailure(backend, String(error?.message || error), error)
  }
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch (error) {
    throw new SearchFailure(backend, `unparseable response (HTTP ${response.status})`, error)
  }
  if (!response.ok) throw new SearchFailure(backend, describeStatus(backend, response.status, data))
  return data
}

function describeStatus(backend, status, data) {
  const detail =
    data?.error?.message ||
    data?.message ||
    data?.detail ||
    (Array.isArray(data?.errors) ? data.errors.map((e) => e?.message || e?.code || String(e)).join('; ') : '')
  const suffix = detail ? `: ${detail}` : ''
  if (status === 401 || status === 403) return `rejected the credential (HTTP ${status})${suffix}`
  if (status === 402) return `quota exhausted (HTTP 402)${suffix}`
  if (status === 429) return `rate limited (HTTP 429)${suffix}`
  if (status >= 500) return `unavailable (HTTP ${status})${suffix}`
  return `request failed (HTTP ${status})${suffix}`
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
