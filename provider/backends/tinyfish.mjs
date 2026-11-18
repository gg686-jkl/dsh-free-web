import { requestJson, toSources } from '../backend.mjs'

/**
 * TinyFish — free search and fetch, one API key.
 *
 * Search: GET  https://api.search.tinyfish.ai?query=…
 * Fetch:  POST https://api.fetch.tinyfish.ai  {"urls":[url]}  → extracted page text
 *
 * Free allowances (verified 2026-11 against https://www.tinyfish.ai/pricing):
 * search 30 requests/min and 500/hour, fetch 150 URLs/min and 1,000/day. Neither draws
 * from the wallet, so both keep working at a $0 balance.
 */
export const id = 'tinyfish'
export const title = 'TinyFish'

export const available = (settings) => Boolean(settings.apiKey)

export async function search({ query, maxResults, signal, settings }) {
  const url = new URL(settings.searchUrl)
  url.searchParams.set('query', query)
  if (maxResults) url.searchParams.set('limit', String(maxResults))
  const data = await requestJson(
    url,
    { headers: { 'X-API-Key': settings.apiKey, Accept: 'application/json' } },
    signal,
    settings.timeoutMs,
    id,
  )
  const rows = Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : []
  return toSources(rows, { date: 'date' })
}

/** One page as extracted text. Returns the seam's WebFetchResult, or throws. */
export async function fetchPage({ url, signal }, settings) {
  const data = await requestJson(
    settings.fetchUrl,
    {
      method: 'POST',
      headers: { 'X-API-Key': settings.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ urls: [url] }),
    },
    signal,
    settings.timeoutMs,
    id,
  )
  const first = Array.isArray(data.results) ? data.results[0] : undefined
  if (!first) {
    const detail = Array.isArray(data.errors)
      ? data.errors.map((e) => e?.message || e?.code || String(e)).join('; ')
      : ''
    throw new Error(detail || `TinyFish returned no content for ${url}`)
  }
  const content = typeof first.text === 'string' ? first.text : typeof first.description === 'string' ? first.description : ''
  if (!content.trim()) throw new Error(`TinyFish returned an empty body for ${url}`)
  return {
    url: typeof first.final_url === 'string' && first.final_url ? first.final_url : url,
    statusCode: 200,
    body: { kind: 'text', content },
    truncated: false,
  }
}
