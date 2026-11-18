/**
 * Fusion across backends.
 *
 * Two things decide what the model sees:
 *
 * 1. **Rank fusion.** A source's score is the sum, over the lists it appears in, of
 *    `weight × quality / (k + rank)`. k=60 is the value from the original RRF paper. The
 *    backend weight is how much that backend's ordering has earned (measured with
 *    `probe.mjs --bench`), so one noisy source cannot outvote three good ones.
 * 2. **Collapsing duplicates.** First by normalised URL — different tracking parameters are
 *    the same page. Then by title: several backends index the same article under the same
 *    title with different URLs, and reporting it three times wastes the model's context.
 *
 * A source is never dropped for looking bad. Low-quality entries are down-weighted, which
 * matters when one of them is the only answer.
 */

const TRACKING = /^(utm_|ref$|ref_|gclid|fbclid|mc_cid|mc_eid|spm|from$|share_|_hs|igshid|si$)/i

/** A URL reduced to the identity a reader would recognise: no tracking, no https/www noise. */
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

/** Title with presentation noise removed, for comparing two listings of the same page. */
export function titleKey(title) {
  if (typeof title !== 'string') return ''
  return title
    .replace(/<[^>]*>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+[|·—–-]\s+[^|·—–-]{1,40}$/u, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * How much a single source deserves its rank.
 *
 * The one defect worth correcting is a listing whose "title" is just the address — Keenable
 * returns those for pages it could not parse. It still might be the right page, so this is a
 * penalty, not a removal.
 */
export function quality(source) {
  const title = typeof source.title === 'string' ? source.title.trim() : ''
  if (!title) return source.snippet ? 0.7 : 0.5
  if (/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(title)) return 0.6
  if (titleKey(title).split(' ').length < 2) return 0.8
  return 1
}

function tokens(text) {
  return new Set(
    (text || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  )
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** Query-word coverage of a listing: how much of what was asked appears in it. */
export function coverage(query, source) {
  const wanted = tokens(query)
  if (!wanted.size) return 0
  const have = tokens(`${source.title ?? ''} ${source.snippet ?? ''}`)
  let hit = 0
  for (const token of wanted) if (have.has(token)) hit += 1
  return hit / wanted.size
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

/**
 * @param entries  `[{ id, sources, trust }]` — one per backend that answered
 * @param limit    how many sources to return
 * @param options  `{ k, weights, query, lexical, maxPerHost }`
 *   weights     override each backend's own trust
 *   query       the search string; enables `lexical` weighting when given
 *   lexical     λ for query-word coverage, 0 disables it (default 0)
 *   maxPerHost  cap on results from one host; extras are demoted, never dropped (default 0 = off)
 * @returns        `{ sources, merged, contributed }`
 *   merged      — how many entries the duplicate passes removed
 *   contributed — per backend, how many of its sources survived into the result
 */
export function fuse(entries, limit, options = {}) {
  const k = options.k ?? 60
  const weights = options.weights ?? {}
  const lexical = Math.max(0, options.lexical ?? 0)
  const query = typeof options.query === 'string' ? options.query : ''
  const maxPerHost = Math.max(0, Math.floor(options.maxPerHost ?? 0))
  const scored = new Map()
  const contributed = {}

  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = entry?.id ?? 'unknown'
    const sources = Array.isArray(entry?.sources) ? entry.sources : []
    if (!sources.length) continue
    const weight = Number.isFinite(weights[id]) ? weights[id] : Number.isFinite(entry.trust) ? entry.trust : 1
    if (weight <= 0) continue
    sources.forEach((source, rank) => {
      const key = normaliseUrl(source.url)
      const score = (weight * quality(source)) / (k + rank + 1)
      const seen = scored.get(key)
      if (seen) {
        seen.score += score
        seen.sources.push(id)
        if (source.title && !seen.source.title) seen.source.title = source.title
        if (source.snippet && !seen.source.snippet) seen.source.snippet = source.snippet
        if (source.publishedAt && !seen.source.publishedAt) seen.source.publishedAt = source.publishedAt
      } else {
        scored.set(key, { score, source: { ...source }, sources: [id] })
      }
    })
  }

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score)

  // Second pass: the same page listed under the same title at a different URL.
  const kept = []
  let merged = 0
  for (const candidate of ranked) {
    const key = titleKey(candidate.source.title)
    const snippet = tokens(candidate.source.snippet)
    const duplicate = key
      ? kept.find((existing) => {
          if (titleKey(existing.source.title) !== key) return false
          const sameHost = host(existing.source.url) === host(candidate.source.url)
          return sameHost || jaccard(tokens(existing.source.snippet), snippet) >= 0.5
        })
      : undefined
    if (duplicate) {
      merged += 1
      duplicate.score += candidate.score * 0.5
      if (!duplicate.source.snippet && candidate.source.snippet) duplicate.source.snippet = candidate.source.snippet
      if (!duplicate.source.publishedAt && candidate.source.publishedAt) duplicate.source.publishedAt = candidate.source.publishedAt
      continue
    }
    kept.push(candidate)
  }

  kept.sort((a, b) => b.score - a.score)
  // Query-word coverage: RRF says which answers the backends agree on, this says which ones
  // actually contain what was asked. Off unless λ is set.
  const ordered =
    lexical > 0 && query
      ? [...kept]
          .map((entry) => ({ ...entry, score: entry.score * (1 + lexical * coverage(query, entry.source)) }))
          .sort((a, b) => b.score - a.score)
      : kept

  // One host must not own the answer list: heterogeneous sources serve the reader better, and a
  // site that repeats itself rarely adds information after the second hit. Extras are demoted.
  let final = ordered
  if (maxPerHost > 0) {
    const seen = new Map()
    const head = []
    const tail = []
    for (const entry of ordered) {
      const key = host(entry.source.url)
      const used = seen.get(key) ?? 0
      seen.set(key, used + 1)
      if (used < maxPerHost) head.push(entry)
      else tail.push(entry)
    }
    final = [...head, ...tail]
  }

  const sources = final.slice(0, Math.max(1, limit)).map((entry) => entry.source)
  for (const source of sources) {
    const key = normaliseUrl(source.url)
    for (const id of scored.get(key)?.sources ?? []) contributed[id] = (contributed[id] ?? 0) + 1
  }
  return { sources, merged, contributed }
}
