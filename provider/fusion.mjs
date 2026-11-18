/**
 * Fusion across backends.
 *
 * Reciprocal rank fusion: a source's score is the sum over the lists it appears in of
 * 1/(k + rank). k=60 is the value from the original RRF paper and the one that keeps a
 * single list's top hit from dominating a source that three lists agree on.
 *
 * Deduplication is by a normalised URL: scheme and host lowercase, tracking parameters and
 * fragments dropped, trailing slash removed. Two backends almost never agree on the exact
 * same string, and reporting the same page twice wastes the model's context.
 */

const TRACKING = /^(utm_|ref$|ref_|gclid|fbclid|mc_cid|mc_eid|spm|from$|share_|_hs|igshid|si$)/i

export function normaliseUrl(raw) {
  try {
    const url = new URL(raw)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING.test(key)) url.searchParams.delete(key)
    }
    url.protocol = 'https:'
    url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase()
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    const query = url.searchParams.toString()
    return `${url.hostname}${url.pathname}${query ? `?${query}` : ''}`
  } catch {
    return raw
  }
}

/**
 * @param lists  one array of sources per backend, best-ranked first
 * @param limit  how many sources to return
 * @returns      { sources, contributors } — contributors is the per-backend count that made it in
 */
export function fuse(lists, limit, k = 60) {
  const merged = new Map()
  for (const list of lists) {
    list.forEach((source, rank) => {
      const key = normaliseUrl(source.url)
      const score = 1 / (k + rank + 1)
      const seen = merged.get(key)
      if (seen) {
        seen.score += score
        // Keep the richest metadata any list offered, preferring the higher-ranked one.
        seen.source = { ...source, ...seen.source, ...(source.title ? { title: source.title } : {}) }
        if (!seen.source.snippet && source.snippet) seen.source.snippet = source.snippet
      } else {
        merged.set(key, { score, source: { ...source } })
      }
    })
  }
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score)
  return ranked.slice(0, limit).map((entry) => entry.source)
}
