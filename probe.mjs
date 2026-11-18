#!/usr/bin/env node
/**
 * Measure the backends without starting dsh.
 *
 *   node probe.mjs                        # default query set, every backend
 *   node probe.mjs "query one" "query two"
 *   node probe.mjs --backend keenable --fetch https://example.com
 *   node probe.mjs --bench                # recall@5 / junk rate / latency per backend
 *
 * `--bench` is the one that decides defaults: bench/queries.json lists queries whose answer
 * URL is known, and the table says which backend ranks those answers highest. Change a
 * backend's `trust` only with this table in hand.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fuse } from './provider/fusion.mjs'
import * as tinyfish from './provider/backends/tinyfish.mjs'
import * as keenable from './provider/backends/keenable.mjs'
import * as anysearch from './provider/backends/anysearch.mjs'
import * as exa from './provider/backends/exa.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKENDS = { tinyfish, keenable, anysearch, exa }
const DEFAULTS = {
  searchUrl: 'https://api.search.tinyfish.ai',
  fetchUrl: 'https://api.fetch.tinyfish.ai',
  keenableEndpoint: 'https://api.keenable.ai/v1/search/public',
  anysearchEndpoint: 'https://api.anysearch.com/v1/search',
  exaEndpoint: 'https://mcp.exa.ai/mcp',
  clientTitle: 'dsh-web',
  timeoutMs: 8000,
}

const args = process.argv.slice(2)
const queries = []
let only
let fetchUrl
let bench = false
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--backend') only = args[++i]
  else if (args[i] === '--fetch') fetchUrl = args[++i]
  else if (args[i] === '--bench') bench = true
  else queries.push(args[i])
}

const apiKey = (() => {
  try {
    return readFileSync(join(process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh'), 'tinyfish.key'), 'utf8').trim()
  } catch {
    return ''
  }
})()

const settings = (id) => ({
  ...DEFAULTS,
  apiKey,
  endpoint:
    { keenable: DEFAULTS.keenableEndpoint, anysearch: DEFAULTS.anysearchEndpoint, exa: DEFAULTS.exaEndpoint }[id] ?? '',
})

const pad = (text, width) => String(text).padEnd(width)
const ms = (n) => `${Math.round(n)}ms`
const pct = (n) => `${Math.round(n * 100)}%`

async function ask(id, backend, query, maxResults = 8) {
  const started = performance.now()
  try {
    const sources = await backend.search({
      query,
      maxResults,
      signal: AbortSignal.timeout(DEFAULTS.timeoutMs),
      settings: settings(id),
    })
    return { id, sources, latency: performance.now() - started, error: undefined }
  } catch (error) {
    return { id, sources: [], latency: performance.now() - started, error: error.message }
  }
}

/** A result "answers" when one of the expected URL fragments is in it. */
const hits = (sources, expect) =>
  sources.slice(0, 5).some((source) => expect.some((fragment) => source.url.toLowerCase().includes(fragment.toLowerCase())))

/** A listing whose title is just its address is noise, whatever it points at. */
const isJunk = (source) => !source.title || /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(source.title.trim())

async function runBench() {
  const cases = JSON.parse(readFileSync(join(HERE, 'bench', 'queries.json'), 'utf8'))
  const ids = Object.keys(BACKENDS).filter((id) => !only || only === id).filter((id) => BACKENDS[id].available(settings(id)) !== false)
  const rows = Object.fromEntries(ids.map((id) => [id, { n: 0, hit: 0, junk: 0, seen: 0, latencies: [] }]))
  const fused = { n: 0, hit: 0, top1: 0, junk: 0, seen: 0, latencies: [] }
  const equalWeights = { n: 0, hit: 0, top1: 0, junk: 0, seen: 0 }
  // Weight sets are compared on the same collected answers, so the sweep costs no extra calls.
  const measured = { exa: 1, tinyfish: 0.95, keenable: 0.9, anysearch: 0.85 }
  const sweep = [
    ['equal', Object.fromEntries(ids.map((id) => [id, 1])), 0],
    ['shipped', Object.fromEntries(ids.map((id) => [id, BACKENDS[id].trust])), 0],
    ['measured', Object.fromEntries(ids.map((id) => [id, measured[id] ?? 0.9])), 0],
    ['exa-only', Object.fromEntries(ids.map((id) => [id, id === 'exa' ? 1 : 0])), 0],
  ].map(([name, weights, bonus]) => ({ name, weights, bonus, n: 0, hit: 0, top1: 0, junk: 0, seen: 0 }))

  for (const item of cases) {
    const startedQuery = performance.now()
    const results = await Promise.all(ids.map((id) => ask(id, BACKENDS[id], item.query)))
    const wallClock = performance.now() - startedQuery
    const entries = []
    for (const result of results) {
      const row = rows[result.id]
      row.n += 1
      row.latencies.push(result.latency)
      if (result.error) continue
      if (result.sources.length) entries.push({ id: result.id, sources: result.sources, trust: BACKENDS[result.id].trust })
      const top = result.sources.slice(0, 5)
      if (hits(result.sources, item.expect)) row.hit += 1
      if (hits(result.sources.slice(0, 1), item.expect)) row.top1 = (row.top1 ?? 0) + 1
      row.seen += top.length
      row.junk += top.filter(isJunk).length
    }
    const merged = fuse(entries, 10).sources
    fused.latencies.push(wallClock)
    fused.n += 1
    if (hits(merged, item.expect)) fused.hit += 1
    if (hits(merged.slice(0, 1), item.expect)) fused.top1 += 1
    const topFused = merged.slice(0, 5)
    fused.seen += topFused.length
    fused.junk += topFused.filter(isJunk).length
    for (const candidate of sweep) {
      const ranked = fuse(entries, 10, { weights: candidate.weights }).sources
      candidate.n += 1
      if (hits(ranked, item.expect)) candidate.hit += 1
      if (hits(ranked.slice(0, 1), item.expect)) candidate.top1 += 1
      candidate.seen += ranked.slice(0, 5).length
      candidate.junk += ranked.slice(0, 5).filter(isJunk).length
    }
    // The same inputs with every weight set to 1: the delta is what weighting is worth.
    const flat = fuse(entries, 10, { weights: Object.fromEntries(ids.map((id) => [id, 1])) }).sources
    equalWeights.n += 1
    if (hits(flat, item.expect)) equalWeights.hit += 1
    if (hits(flat.slice(0, 1), item.expect)) equalWeights.top1 += 1
    equalWeights.seen += flat.slice(0, 5).length
    equalWeights.junk += flat.slice(0, 5).filter(isJunk).length
    console.log(
      `${pad(item.query.slice(0, 52), 54)} ${ids.map((id) => (hits(results.find((r) => r.id === id).sources, item.expect) ? '.' : 'x')).join(' ')}  fused:${hits(merged, item.expect) ? ' .' : ' x'}`,
    )
  }

  const median = (list) => {
    if (!list.length) return 0
    const sorted = [...list].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }

  console.log(
    `\n${pad('backend', 12)} ${pad('recall@5', 12)} ${pad('recall@1', 10)} ${pad('junk', 7)} ${pad('p50', 8)} trust`,
  )
  const line = (name, row, p50, trust) =>
    `${pad(name, 12)} ${pad(`${pct(row.hit / row.n)} (${row.hit}/${row.n})`, 12)} ${pad(`${pct(row.top1 / row.n)} (${row.top1}/${row.n})`, 10)} ${pad(pct(row.seen ? row.junk / row.seen : 0), 7)} ${pad(p50, 8)} ${trust}`
  for (const id of ids) {
    const row = rows[id]
    if (!row.n) continue
    console.log(line(id, { ...row, top1: row.top1 ?? 0 }, ms(median(row.latencies)), BACKENDS[id].trust))
  }
  console.log(line('FUSED', fused, ms(median(fused.latencies)), 'shipped'))
  console.log('\nweight sweep (same answers, different weights):')
  for (const candidate of sweep) {
    console.log(line(`  ${candidate.name}`, candidate, '-', JSON.stringify(candidate.weights)))
  }
  console.log(`\nlegend: . = expected page in top 5, x = missed`)
}

async function runQuery(query) {
  console.log(`\nquery: ${query}`)
  console.log(`${pad('backend', 10)} ${pad('latency', 9)} ${pad('sources', 8)} status`)
  const entries = []
  for (const [id, backend] of Object.entries(BACKENDS)) {
    if (only && only !== id) continue
    if (backend.available(settings(id)) === false) {
      console.log(`${pad(id, 10)} ${pad('-', 9)} ${pad('-', 8)} skipped (no key)`)
      continue
    }
    const result = await ask(id, backend, query)
    if (result.error) {
      console.log(`${pad(id, 10)} ${pad(ms(result.latency), 9)} ${pad('-', 8)} FAILED ${result.error}`)
      continue
    }
    console.log(`${pad(id, 10)} ${pad(ms(result.latency), 9)} ${pad(result.sources.length, 8)} ok`)
    for (const source of result.sources.slice(0, 3)) console.log(`  - ${(source.title || source.url).slice(0, 76)}`)
    if (result.sources.length) entries.push({ id, sources: result.sources, trust: backend.trust })
  }
  if (entries.length) {
    const { sources, merged } = fuse(entries, 5)
    console.log(`  fused${merged ? ` (${merged} near-duplicate(s) collapsed)` : ''}:`)
    for (const source of sources) console.log(`  = ${(source.title || source.url).slice(0, 76)}`)
  } else {
    console.log('  fused: nothing (every backend failed or returned nothing)')
  }
}

async function runFetch(url) {
  const started = performance.now()
  if (apiKey) {
    try {
      const page = await tinyfish.fetchPage({ url }, settings('tinyfish'))
      console.log(`tinyfish fetch: ${ms(performance.now() - started)}, ${page.body.content.length} chars, ${page.body.kind}`)
    } catch (error) {
      console.log(`tinyfish fetch: FAILED ${error.message}`)
    }
  } else {
    console.log('tinyfish fetch: skipped (no key)')
  }
  const exaStart = performance.now()
  try {
    const page = await exa.fetchPage({ url }, settings('exa'))
    console.log(`exa fetch:      ${ms(performance.now() - exaStart)}, ${page.body.content.length} chars, ${page.body.kind}`)
  } catch (error) {
    console.log(`exa fetch:      FAILED ${error.message}`)
  }
  const directStart = performance.now()
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
    const body = await response.text()
    console.log(`direct fetch:   ${ms(performance.now() - directStart)}, HTTP ${response.status}, ${body.length} chars, ${response.headers.get('content-type') || 'no content-type'}`)
  } catch (error) {
    console.log(`direct fetch:   FAILED ${error.message}`)
  }
}

if (bench) await runBench()
else if (fetchUrl) await runFetch(fetchUrl)
else for (const query of queries.length ? queries : ['cordis plugin loader patch yml', 'tinyfish search api pricing', 'deepseek harness agent preset']) await runQuery(query)
