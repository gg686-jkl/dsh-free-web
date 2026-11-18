/**
 * Free web search and fetch behind dsh's own `web_search` / `web_fetch` tools.
 *
 * `@deepseek-ai/dsh-tool-web` owns the model-facing tool names, schemas, prompt guidance and
 * rendering; this plugin only registers providers on the `ctx.web` seam. The model sees the
 * shipped tools, unchanged, while the calls fan out over free backends:
 *
 *   search → tinyfish (key) + keenable + anysearch + exa (all keyless)
 *            in parallel, fused with weighted reciprocal rank fusion
 *   fetch  → tinyfish extracted text (key) → exa markdown (keyless) → direct HTTP
 *
 * A soft deadline returns whatever has arrived rather than waiting for the slowest backend,
 * a cache answers repeated queries from memory, a breaker stops calling a backend that keeps
 * failing, and one retry covers rate limits. All of it is measured by `probe.mjs --bench`.
 *
 * Registered provider ids: `free-web` (primary) and `tinyfish` (alias, so configuration
 * written for v1.1 keeps working). Backend knowledge — endpoints, quotas, access rules — is
 * adapted from bestnite/search (MIT): https://github.com/bestnite/search
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAILURE } from './backend.mjs'
import { fuse } from './fusion.mjs'
import { Breaker, Cache, withRetry } from './resilience.mjs'
import * as tinyfish from './backends/tinyfish.mjs'
import * as keenable from './backends/keenable.mjs'
import * as anysearch from './backends/anysearch.mjs'
import * as exa from './backends/exa.mjs'

export const name = 'web-tinyfish'
export const inject = ['web']

const BACKENDS = { tinyfish, keenable, anysearch, exa }

const DEFAULTS = {
  /** Enabled by default: one keyed backend plus three that need no account at all. */
  backends: ['tinyfish', 'keenable', 'anysearch', 'exa'],
  /** Backends that exist but stay off unless asked for. */
  extraBackends: [],
  perBackendTimeoutMs: 8_000,
  overallTimeoutMs: 20_000,
  /** Return what has arrived by now instead of waiting for the slowest backend. */
  softDeadlineMs: 800,
  /** ...unless fewer than this many sources are in hand, ... */
  minResults: 3,
  /** ...or fewer than this many backends have answered. One voice is not a consensus. */
  minBackends: 2,
  /** The floor above is bounded: past this, a partial answer beats a slow one. */
  worstCaseMs: 2_500,
  /** One retry for a rate limit or a transient 5xx. */
  retries: 2,
  retryDelayMs: 300,
  breakerThreshold: 3,
  breakerCooldownMs: 60_000,
  cacheTtlMs: 300_000,
  cacheEntries: 200,
  fetchFallback: true,
  /** A TinyFish page shorter than this is treated as a miss and handed to the next hop. */
  thinContentChars: 200,
  maxFetchBytes: 8 * 1024 * 1024,
  /** Overrides each backend's own `trust`; measured with `node probe.mjs --bench`. */
  weights: {},
  /** Site diversity: how many results one host may contribute before extras are demoted. */
  maxPerHost: 2,
  /** Query-word coverage weighting; 0 keeps pure rank fusion. */
  lexical: 0,
  keyFile: '',
  clientTitle: 'dsh-web',
  searchUrl: 'https://api.search.tinyfish.ai',
  fetchUrl: 'https://api.fetch.tinyfish.ai',
  keenableEndpoint: 'https://api.keenable.ai/v1/search/public',
  anysearchEndpoint: 'https://api.anysearch.com/v1/search',
  exaEndpoint: 'https://mcp.exa.ai/mcp',
}

function resolveKeyFile(settings) {
  if (settings.keyFile) return settings.keyFile
  const home = process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh')
  return join(home, 'tinyfish.key')
}

function readKey(settings) {
  try {
    return readFileSync(resolveKeyFile(settings), 'utf8').trim()
  } catch {
    return ''
  }
}

function failure(code, message, cause) {
  return Object.assign(new Error(message), { code, cause })
}

function backendSettings(settings, apiKey, backendId) {
  return {
    apiKey,
    backendId,
    timeoutMs: settings.perBackendTimeoutMs,
    searchUrl: settings.searchUrl,
    fetchUrl: settings.fetchUrl,
    endpoint:
      {
        keenable: settings.keenableEndpoint,
        anysearch: settings.anysearchEndpoint,
        exa: settings.exaEndpoint,
      }[backendId] ?? '',
    clientTitle: settings.clientTitle,
  }
}

/** Every configured backend that can actually run right now, in configuration order. */
function configuredBackends(settings) {
  const ids = [...new Set([...(settings.backends || []), ...(settings.extraBackends || [])])]
  const apiKey = readKey(settings)
  return ids
    .map((id) => ({ id, backend: BACKENDS[id] }))
    .filter((entry) => entry.backend)
    .map((entry) => ({ ...entry, settings: backendSettings({ ...settings }, apiKey, entry.id) }))
    .filter((entry) => {
      try {
        return entry.backend.available(entry.settings) !== false
      } catch {
        return false
      }
    })
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  const cache = new Cache({ ttlMs: settings.cacheTtlMs, entries: settings.cacheEntries })
  const breaker = new Breaker({ threshold: settings.breakerThreshold, cooldownMs: settings.breakerCooldownMs })
  const debug = () => process.env.DSH_WEB_DEBUG === '1'
  const warn = (message) => {
    try {
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
      else console.warn(`[web-tinyfish] ${message}`)
    } catch {
      /* logging must never break a search */
    }
  }

  const search = async (request, signal) => {
    const all = configuredBackends(settings)
    // A breaker never leaves the call with nothing to try: if it filtered everything, the
    // attempt is worth making anyway, and the failure reason reaches the caller.
    const healthy = all.filter((entry) => breaker.allows(entry.id))
    const enabled = healthy.length ? healthy : all
    if (!enabled.length) {
      throw failure(
        'WEB_PROVIDER_UNAVAILABLE',
        `no search backend is available: enable a keyless backend (${Object.keys(BACKENDS).join(', ')}) or provide a TinyFish key at ${resolveKeyFile(settings)}`,
      )
    }

    const maxResults = Number.isInteger(request.maxResults) && request.maxResults > 0 ? request.maxResults : 8
    const cacheKey = `${request.query}\u0000${maxResults}\u0000${enabled.map((entry) => entry.id).join(',')}`
    const cached = cache.get(cacheKey)
    if (cached) {
      if (debug()) warn(`cache hit for "${request.query.slice(0, 60)}"`)
      return cached
    }

    // Ask each backend for a few extra rows so fusion has something to rank.
    const perBackend = Math.min(20, Math.max(maxResults, 5))
    const overall = AbortSignal.timeout(settings.overallTimeoutMs)
    const composite = signal ? AbortSignal.any([signal, overall]) : overall
    const stop = new AbortController()
    const scoped = AbortSignal.any([composite, stop.signal])

    const started = Date.now()
    const timings = new Map()
    const outcomes = await settleUntil(
      enabled.map((entry) =>
        withRetry(
          async () => {
            const at = Date.now()
            try {
              const sources = await entry.backend.search({ query: request.query, maxResults: perBackend, signal: scoped, settings: entry.settings })
              return sources
            } finally {
              timings.set(entry.id, Date.now() - at)
            }
          },
          { attempts: settings.retries, delayMs: settings.retryDelayMs, signal: scoped },
        ),
      ),
      settings.softDeadlineMs,
      { minSources: settings.minResults, minBackends: settings.minBackends, hardDeadlineMs: settings.worstCaseMs },
    )
    stop.abort()

    const lists = []
    const failures = []
    const openCircuits = []
    outcomes.forEach((outcome, index) => {
      const { id, backend } = enabled[index]
      if (!outcome) {
        // Still running when the ceiling passed: not a failure, but the caller deserves to know.
        failures.push(`${id}: no answer within ${settings.worstCaseMs}ms`)
        return
      }
      if (outcome.ok) {
        breaker.success(id)
        if (outcome.value.length) lists.push({ id, sources: outcome.value, trust: backend.trust })
      } else {
        const reason = outcome.reason
        const aborted = reason?.name === 'AbortError' || reason?.kind === FAILURE.timeout
        if (!aborted) {
          const immediate = reason?.kind === FAILURE.rateLimit || reason?.kind === FAILURE.quota
          if (breaker.failure(id, immediate)) openCircuits.push(id)
          failures.push(String(reason?.message || reason).slice(0, 300))
        }
      }
    })

    if (!lists.length) {
      const why = failures.length ? failures.join(' | ') : 'every backend answered with no results'
      throw failure('WEB_PROVIDER_FAILED', `web search failed — ${why}`)
    }
    if (failures.length) warn(`search degraded, ${lists.length}/${enabled.length} backend(s) answered: ${failures.join(' | ')}`)
    if (openCircuits.length) warn(`skipped for ${Math.round(settings.breakerCooldownMs / 1000)}s after repeated failures: ${openCircuits.join(', ')}`)

    const fused = fuse(lists, maxResults, { weights: settings.weights, query: request.query, lexical: settings.lexical, maxPerHost: settings.maxPerHost })
    if (fused.merged) warn(`collapsed ${fused.merged} near-duplicate result(s)`)
    const result = { sources: fused.sources, truncated: false }
    if (debug()) {
      const detail = [...timings].map(([id, ms]) => `${id} ${ms}ms`).join(', ')
      warn(`search "${request.query.slice(0, 60)}" in ${Date.now() - started}ms (${detail}) → ${result.sources.length} sources`)
    }
    cache.set(cacheKey, result)
    return result
  }

  const fetchPage = async (request, signal) => {
    const apiKey = readKey(settings)
    const reasons = []
    // 1. TinyFish: the cleanest extraction, but it needs a key.
    if (apiKey) {
      try {
        const page = await tinyfish.fetchPage({ url: request.url, signal }, backendSettings(settings, apiKey, 'tinyfish'))
        if (page.body.content.trim().length >= settings.thinContentChars) return page
        reasons.push(`tinyfish: only ${page.body.content.trim().length} characters`)
      } catch (error) {
        reasons.push(`tinyfish: ${error?.message || error}`)
      }
    }
    if (settings.fetchFallback) {
      // 2. Exa's keyless MCP tier answers with markdown, so a key is never required for text.
      try {
        return await exa.fetchPage({ url: request.url, signal }, backendSettings(settings, apiKey, 'exa'))
      } catch (error) {
        reasons.push(`exa: ${error?.message || error}`)
      }
      // 3. A direct read always works; the tool layer converts HTML to markdown itself.
      try {
        return await directFetch(request.url, signal, settings)
      } catch (error) {
        reasons.push(`direct: ${error?.message || error}`)
      }
    }
    throw failure('WEB_FETCH_FAILED', `could not read ${request.url} — ${reasons.join(' | ')}`)
  }

  for (const id of ['free-web', 'tinyfish']) {
    ctx.effect(() =>
      ctx.web.registerSearchProvider({
        id,
        available: () => configuredBackends(settings).length > 0,
        ready: async () => configuredBackends(settings).length > 0,
        search,
      }),
    )
    ctx.effect(() =>
      ctx.web.registerFetchProvider({
        id,
        available: () => true,
        ready: async () => true,
        fetch: fetchPage,
      }),
    )
  }
}

/**
 * Wait for the backends until the soft deadline, then hand back whatever has arrived.
 *
 * `outcomes[i]` stays undefined for a task still running when the deadline passes: the caller
 * aborts it afterwards, and a straggler is not a failure — it simply arrived too late to be
 * worth the reader's time. If too little has arrived to be useful, the wait continues.
 */
async function settleUntil(tasks, softDeadlineMs, { minSources, minBackends, hardDeadlineMs }) {
  const outcomes = new Array(tasks.length)
  let done = 0
  let sources = 0
  let answered = 0
  tasks.forEach((task, index) => {
    task.then(
      (value) => {
        outcomes[index] = { ok: true, value }
        done += 1
        sources += value.length
        if (value.length) answered += 1
      },
      (reason) => {
        outcomes[index] = { ok: false, reason }
        done += 1
      },
    )
  })
  const started = Date.now()
  const enough = () => sources >= minSources && answered >= minBackends
  while (done < tasks.length && Date.now() - started < softDeadlineMs) {
    if (enough()) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  // Not enough yet: keep waiting, but only up to the hard ceiling. A free tier that answers in
  // four seconds is still a worse answer than three sources now.
  while (!enough() && done < tasks.length && Date.now() - started < hardDeadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  // Nothing at all and something still running: an empty answer is worth no one's time, so the
  // ceiling does not apply — the caller's own timeout is the backstop.
  if (sources === 0 && done < tasks.length) await Promise.allSettled(tasks)
  return outcomes
}

/**
 * A plain HTTP read, used when the extraction tiers miss. HTML stays HTML: the tool layer
 * converts it to markdown, and guessing at readability here would silently drop content.
 */
async function directFetch(url, signal, settings) {
  const timeout = AbortSignal.timeout(settings.overallTimeoutMs)
  const composite = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,zh-CN;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; dsh-web/1.4; +https://github.com/gg686-jkl/dsh-free-web)',
      },
      signal: composite,
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') throw failure('WEB_PROVIDER_TIMEOUT', `fetch timed out after ${settings.overallTimeoutMs}ms`, error)
    throw failure('WEB_FETCH_FAILED', `fetch failed: ${error?.message || error}`, error)
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > settings.maxFetchBytes) {
    throw failure('WEB_FETCH_UNSUPPORTED', `${Math.round(declared / 1024 / 1024)}MB exceeds the ${Math.round(settings.maxFetchBytes / 1024 / 1024)}MB read limit`)
  }
  if (/^(image|audio|video)\//.test(contentType) || contentType.includes('application/pdf') || contentType.includes('application/zip')) {
    throw failure('WEB_FETCH_UNSUPPORTED', `cannot read ${contentType.split(';')[0]} as text`)
  }
  if (!response.ok && !contentType.includes('html')) {
    throw failure('WEB_FETCH_FAILED', `fetch failed (HTTP ${response.status})`)
  }
  const { bytes, truncated } = await readCapped(response, settings.maxFetchBytes)
  const isHtml = contentType.includes('html')
  const isText =
    isHtml ||
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml') ||
    !contentType
  if (!isText) {
    throw failure('WEB_FETCH_UNSUPPORTED', `cannot read ${contentType || 'an unknown content type'} as text`)
  }
  const content = decode(bytes, charsetOf(contentType, bytes))
  if (!content.trim()) throw failure('WEB_FETCH_UNSUPPORTED', `no content at ${url}`)
  return {
    url: response.url || url,
    statusCode: response.status,
    body: { kind: isHtml ? 'html' : 'text', content },
    truncated,
  }
}

/** Read a body, refusing to buffer more than `limit` bytes. */
async function readCapped(response, limit) {
  if (!response.body) {
    const whole = Buffer.from(await response.arrayBuffer())
    return { bytes: whole.subarray(0, limit), truncated: whole.length > limit }
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    if (total + chunk.length > limit) {
      chunks.push(chunk.subarray(0, limit - total))
      total = limit
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(chunk)
    total += chunk.length
  }
  return { bytes: Buffer.concat(chunks, total), truncated }
}

/** The page's own charset when it states one, so a GBK or Shift_JIS page is not mojibake. */
function charsetOf(contentType, buffer) {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType)?.[1]
  if (fromHeader) return fromHeader
  const head = buffer.subarray(0, 2048).toString('latin1')
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8'
}

function decode(buffer, label) {
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  }
}
