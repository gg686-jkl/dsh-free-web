/**
 * Free web search and fetch behind dsh's own `web_search` / `web_fetch` tools.
 *
 * `@deepseek-ai/dsh-tool-web` owns the model-facing tool names, schemas, prompt guidance and
 * rendering; this plugin only registers providers on the `ctx.web` seam. The model sees the
 * shipped tools, unchanged, while the calls fan out over free backends:
 *
 *   search → tinyfish (key) + keenable + anysearch + exa (all keyless)
 *            in parallel, fused with reciprocal rank fusion
 *   fetch  → tinyfish extracted text (key), falling back to a direct HTTP read
 *
 * No key is required to start: the keyless backends answer searches, and a direct HTTP read
 * answers fetches. A TinyFish key adds one more search voice and clean page text.
 *
 * Registered provider ids: `free-web` (primary) and `tinyfish` (alias, so configuration
 * written for v1.1 keeps working). Backend knowledge — endpoints, quotas, access rules — is
 * adapted from bestnite/search (MIT): https://github.com/bestnite/search
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SearchFailure } from './backend.mjs'
import { fuse } from './fusion.mjs'
import * as tinyfish from './backends/tinyfish.mjs'
import * as keenable from './backends/keenable.mjs'
import * as anysearch from './backends/anysearch.mjs'
import * as exa from './backends/exa.mjs'

export const name = 'web-tinyfish'
export const inject = ['web']

const BACKENDS = { tinyfish, keenable, anysearch, exa }

const DEFAULTS = {
  /** Enabled by default: one keyed backend plus two that need no account at all. */
  backends: ['tinyfish', 'keenable', 'anysearch', 'exa'],
  /** Backends that exist but stay off unless asked for. */
  extraBackends: [],
  perBackendTimeoutMs: 8_000,
  overallTimeoutMs: 20_000,
  fetchFallback: true,
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

function backendSettings(settings, apiKey) {
  return {
    apiKey,
    timeoutMs: settings.perBackendTimeoutMs,
    searchUrl: settings.searchUrl,
    fetchUrl: settings.fetchUrl,
    endpoint:
      {
        keenable: settings.keenableEndpoint,
        anysearch: settings.anysearchEndpoint,
        exa: settings.exaEndpoint,
      }[settings.backendId] ?? '',
    clientTitle: settings.clientTitle,
  }
}

/** Every configured backend that can actually run right now, in configuration order. */
function enabledBackends(settings) {
  const ids = [...new Set([...(settings.backends || []), ...(settings.extraBackends || [])])]
  const apiKey = readKey(settings)
  return ids
    .map((id) => ({ id, backend: BACKENDS[id] }))
    .filter((entry) => entry.backend)
    .map((entry) => ({ ...entry, settings: backendSettings({ ...settings, backendId: entry.id }, apiKey) }))
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
  const warn = (message) => {
    try {
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
      else console.warn(`[web-tinyfish] ${message}`)
    } catch {
      /* logging must never break a search */
    }
  }

  const search = async (request, signal) => {
    const enabled = enabledBackends(settings)
    if (!enabled.length) {
      throw failure(
        'WEB_PROVIDER_UNAVAILABLE',
        `no search backend is available: enable a keyless backend (${Object.keys(BACKENDS).join(', ')}) or provide a TinyFish key at ${resolveKeyFile(settings)}`,
      )
    }

    const overall = AbortSignal.timeout(settings.overallTimeoutMs)
    const composite = signal ? AbortSignal.any([signal, overall]) : overall
    const maxResults = Number.isInteger(request.maxResults) && request.maxResults > 0 ? request.maxResults : 8
    // Ask each backend for a few extra rows so fusion has something to rank.
    const perBackend = Math.min(20, Math.max(maxResults, 5))

    const settled = await Promise.allSettled(
      enabled.map((entry) => entry.backend.search({ query: request.query, maxResults: perBackend, signal: composite, settings: entry.settings })),
    )

    const lists = []
    const failures = []
    settled.forEach((outcome, index) => {
      const id = enabled[index].id
      if (outcome.status === 'fulfilled') {
        if (outcome.value.length) lists.push(outcome.value)
      } else {
        const reason = outcome.reason instanceof SearchFailure ? outcome.reason.message : `${id}: ${outcome.reason?.message || outcome.reason}`
        failures.push(reason)
      }
    })

    if (!lists.length) {
      const why = failures.length ? failures.join(' | ') : 'every backend answered with no results'
      throw failure('WEB_PROVIDER_FAILED', `web search failed — ${why}`)
    }
    // A partial failure is reported, never fatal: the model still gets what came back.
    if (failures.length) warn(`search degraded, ${lists.length}/${enabled.length} backend(s) answered: ${failures.join(' | ')}`)

    return { sources: fuse(lists, maxResults), truncated: false }
  }

  const fetchPage = async (request, signal) => {
    const apiKey = readKey(settings)
    if (apiKey) {
      try {
        return await tinyfish.fetchPage({ url: request.url, signal }, backendSettings({ ...settings, backendId: 'tinyfish' }, apiKey))
      } catch (error) {
        if (!settings.fetchFallback) {
          throw failure('WEB_FETCH_FAILED', `tinyfish: ${error?.message || error}`, error)
        }
        warn(`fetch fell back to a direct read for ${request.url}: ${error?.message || error}`)
      }
    }
    return directFetch(request.url, signal, settings)
  }

  for (const id of ['free-web', 'tinyfish']) {
    ctx.effect(() =>
      ctx.web.registerSearchProvider({
        id,
        available: () => enabledBackends(settings).length > 0,
        ready: async () => enabledBackends(settings).length > 0,
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
 * A plain HTTP read, used when no TinyFish key is configured or the extraction call failed.
 * HTML stays HTML: the tool layer renders it, and guessing at readability would silently drop
 * the parts of a page that matter.
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
        'User-Agent': 'Mozilla/5.0 (compatible; dsh-web/1.2; +https://github.com/gg686-jkl/dsh-tinyfish)',
      },
      signal: composite,
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') throw failure('WEB_PROVIDER_TIMEOUT', `fetch timed out after ${settings.overallTimeoutMs}ms`, error)
    throw failure('WEB_FETCH_FAILED', `fetch failed: ${error?.message || error}`, error)
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (!response.ok && !contentType.includes('html')) {
    throw failure('WEB_FETCH_FAILED', `fetch failed (HTTP ${response.status})`)
  }
  const isHtml = contentType.includes('html')
  const isText = isHtml || contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml') || !contentType
  if (!isText) {
    throw failure('WEB_FETCH_UNSUPPORTED', `cannot read ${contentType || 'an unknown content type'} as text`)
  }
  const content = await response.text()
  if (!content.trim()) throw failure('WEB_FETCH_UNSUPPORTED', `no content at ${url}`)
  return {
    url: response.url || url,
    statusCode: response.status,
    body: { kind: isHtml ? 'html' : 'text', content },
    truncated: false,
  }
}
