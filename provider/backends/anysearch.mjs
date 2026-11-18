import { requestJson, toSources } from '../backend.mjs'

/**
 * AnySearch — keyless public search.
 *
 * Contract (verified 2026-11 against https://anysearch.com/docs/api-endpoints/v1-search.md):
 *   POST https://api.anysearch.com/v1/search   {"query":"…","max_results":N}
 *   → {code:0,data:{results:[{title,url,snippet,content}]}}
 *
 * Free allowance: daily IP-metered quota resets at 00:00 UTC (1,000 calls/day on the free
 * plan). No key needed; an account raises the limit but is never required here.
 */
export const id = 'anysearch'
export const title = 'AnySearch'

export const available = () => true

export async function search({ query, maxResults, signal, settings }) {
  const data = await requestJson(
    settings.endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, max_results: maxResults || 10 }),
    },
    signal,
    settings.timeoutMs,
    id,
  )
  const rows = data?.data?.results ?? data?.results
  return toSources(rows)
}
