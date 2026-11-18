#!/usr/bin/env node
/**
 * Measure the backends without starting dsh.
 *
 *   node probe.mjs                        # default query set, every backend
 *   node probe.mjs "query one" "query two"
 *   node probe.mjs --backend keenable --fetch https://example.com
 *   node probe.mjs --bench                # per-backend table + strategy comparison
 *
 * `--bench` collects every backend's answer once, then scores several fusion strategies on
 * that same collected data: no strategy gets a second, luckier sample. Numbers carry a
 * Wilson 95% interval, and the rule is to leave a knob alone when the intervals overlap —
 * the previous release shipped and then removed a "best rank bonus" that only ever moved
 * the result by noise.
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
let skip = []
let paceMs = 200
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--backend') only = args[++i]
  else if (args[i] === '--fetch') fetchUrl = args[++i]
  else if (args[i] === '--bench') bench = true
  else if (args[i] === '--skip') skip = args[++i].split(',').map((value) => value.trim()).filter(Boolean)
  else if (args[i] === '--pace') paceMs = Number(args[++i]) || 0
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
    return { id, sources, latency: performance.now() - started }
  } catch (error) {
    return { id, sources: [], latency: performance.now() - started, error: error.message }
  }
}

/** A result "answers" when one of the expected URL fragments is in it. */
const answers = (sources, expect) =>
  sources.some((source) => expect.some((fragment) => source.url.toLowerCase().includes(fragment.toLowerCase())))

/** A listing whose title is just its address is noise, whatever it points at. */
const isJunk = (source) => !source.title || /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(source.title.trim())

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

/** Wilson 95% interval: a proportion from 52 samples deserves an error bar. */
function wilson(hit, n) {
  if (!n) return [0, 0]
  const z = 1.96
  const p = hit / n
  const denominator = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (centre - spread) / denominator), Math.min(1, (centre + spread) / denominator)]
}

const median = (list) => {
  if (!list.length) return 0
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const p90 = (list) => {
  if (!list.length) return 0
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
}

async function runBench() {
  const cases = JSON.parse(readFileSync(join(HERE, 'bench', 'queries.json'), 'utf8'))
  const ids = Object.keys(BACKENDS)
    .filter((id) => !only || only === id)
    .filter((id) => !skip.includes(id))
    .filter((id) => BACKENDS[id].available(settings(id)) !== false)

  const records = []
  const backendStats = Object.fromEntries(ids.map((id) => [id, { n: 0, hit: 0, top1: 0, junk: 0, seen: 0, latencies: [], misses: [] }]))

  for (const [index, item] of cases.entries()) {
    const answersIn = await Promise.all(ids.map((id) => ask(id, BACKENDS[id], item.query)))
    for (const result of answersIn) {
      const stat = backendStats[result.id]
      stat.n += 1
      stat.latencies.push(result.latency)
      if (result.error) stat.misses.push(result.error.slice(0, 40))
      const top = result.sources.slice(0, 5)
      const hit = answers(top, item.expect)
      if (hit) stat.hit += 1
      else stat.misses.push(item.query.slice(0, 30))
      if (answers(result.sources.slice(0, 1), item.expect)) stat.top1 += 1
      stat.seen += top.length
      stat.junk += top.filter(isJunk).length
    }
    records.push({ item, answers: answersIn })
    process.stdout.write(`\rcollected ${index + 1}/${cases.length}`)
    if (paceMs) await new Promise((resolve) => setTimeout(resolve, paceMs))
  }
  process.stdout.write('\r' + ' '.repeat(30) + '\r')

  const strategies = [
    { name: 'baseline', deadline: Infinity, hostCap: 0, lexical: 0 },
    { name: '+deadline700', deadline: 700, hostCap: 0, lexical: 0 },
    { name: '+deadline900', deadline: 900, hostCap: 0, lexical: 0 },
    { name: '+hostcap2', deadline: Infinity, hostCap: 2, lexical: 0 },
    { name: '+lexical0.5', deadline: Infinity, hostCap: 0, lexical: 0.5 },
    { name: 'all(700/host2/lex.5)', deadline: 700, hostCap: 2, lexical: 0.5 },
    { name: 'all(900/host2/lex.5)', deadline: 900, hostCap: 2, lexical: 0.5 },
  ]

  const rows = []
  for (const strategy of strategies) {
    const stat = { n: 0, hit: 0, top1: 0, junk: 0, seen: 0, hostShare: 0, latencies: [], dropped: 0 }
    for (const record of records) {
      const usable = record.answers.filter((answer) => answer.sources.length && answer.latency <= strategy.deadline)
      stat.dropped += record.answers.filter((answer) => answer.sources.length && answer.latency > strategy.deadline).length
      if (!usable.length) {
        stat.n += 1
        continue
      }
      const entries = usable.map((answer) => ({ id: answer.id, sources: answer.sources, trust: BACKENDS[answer.id].trust }))
      const top = fuse(entries, 5, { query: record.item.query, lexical: strategy.lexical, maxPerHost: strategy.hostCap }).sources
      stat.n += 1
      if (answers(top, record.item.expect)) stat.hit += 1
      if (answers(top.slice(0, 1), record.item.expect)) stat.top1 += 1
      stat.seen += top.length
      stat.junk += top.filter(isJunk).length
      const counts = new Map()
      for (const source of top) counts.set(hostOf(source.url), (counts.get(hostOf(source.url)) ?? 0) + 1)
      stat.hostShare += top.length ? Math.max(...counts.values()) / top.length : 0
      stat.latencies.push(Math.max(...usable.map((answer) => answer.latency)))
    }
    rows.push({ strategy, stat })
  }

  console.log(`\nper backend, ${records.length} queries:\n`)
  console.log(`${pad('backend', 12)} ${pad('recall@5', 18)} ${pad('recall@1', 10)} ${pad('junk', 7)} ${pad('p50', 7)} ${pad('p90', 7)} trust`)
  for (const id of ids) {
    const stat = backendStats[id]
    if (!stat.n) continue
    const [lo, hi] = wilson(stat.hit, stat.n)
    console.log(
      `${pad(id, 12)} ${pad(`${pct(stat.hit / stat.n)} (${stat.hit}/${stat.n}) ${pct(lo)}-${pct(hi)}`, 18)} ${pad(pct(stat.top1 / stat.n), 10)} ${pad(pct(stat.seen ? stat.junk / stat.seen : 0), 7)} ${pad(ms(median(stat.latencies)), 7)} ${pad(ms(p90(stat.latencies)), 7)} ${BACKENDS[id].trust}`,
    )
  }

  console.log(`\nstrategies, same collected answers:\n`)
  console.log(`${pad('strategy', 22)} ${pad('recall@5', 18)} ${pad('recall@1', 8)} ${pad('junk', 6)} ${pad('host', 6)} ${pad('p50', 7)} ${pad('p90', 7)} dropped`)
  for (const { strategy, stat } of rows) {
    const [lo, hi] = wilson(stat.hit, stat.n)
    console.log(
      `${pad(strategy.name, 22)} ${pad(`${pct(stat.hit / stat.n)} (${stat.hit}/${stat.n}) ${pct(lo)}-${pct(hi)}`, 18)} ${pad(pct(stat.top1 / stat.n), 8)} ${pad(pct(stat.seen ? stat.junk / stat.seen : 0), 6)} ${pad(pct(stat.hostShare / stat.n), 6)} ${pad(ms(median(stat.latencies)), 7)} ${pad(ms(p90(stat.latencies)), 7)} ${stat.dropped}`,
    )
  }
  console.log('\nhost = mean share of the top host in a top-5; dropped = answers past the deadline.')
  console.log('Recalls whose intervals overlap the baseline are not improvements.')
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
    const { sources, merged } = fuse(entries, 5, { query, maxPerHost: 2 })
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
