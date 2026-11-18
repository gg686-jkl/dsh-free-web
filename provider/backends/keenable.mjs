import { requestJson, toSources } from '../backend.mjs'

/**
 * Keenable — keyless public search.
 *
 * Contract (verified 2026-11 against https://docs.keenable.ai/api-reference.md):
 *   POST https://api.keenable.ai/v1/search/public
 *   X-Keenable-Title: <caller name>   — required, answers 400 without it
 *   {"query":"…","max_results":N}     → {results:[{title,url,snippet,published_at}]}
 *
 * Free allowance: 1,000 requests/hour and 10/second per IP per endpoint. No account needed,
 * so this backend stays usable before anyone signs up for anything.
 */
export const id = 'keenable'
export const title = 'Keenable'

export const available = () => true

export async function search({ query, maxResults, signal, settings }) {
  const data = await requestJson(
    settings.endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Keenable-Title': settings.clientTitle,
      },
      body: JSON.stringify({ query, max_results: maxResults || 10 }),
    },
    signal,
    settings.timeoutMs,
    id,
  )
  return toSources(data.results, { date: 'published_at' })
}
