#!/usr/bin/env node
/**
 * Measure the backends without starting dsh.
 *
 *   node probe.mjs                        # default query set, every backend
 *   node probe.mjs "query one" "query two"
 *   node probe.mjs --backend keenable --fetch https://example.com
 *
 * Prints, per backend, the latency, how many sources came back and their titles; then the
 * fused list the model would actually see. This is the tool that decides which backends are
 * worth enabling by default — change the defaults only with its numbers in hand.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fuse } from './provider/fusion.mjs'
import * as tinyfish from './provider/backends/tinyfish.mjs'
import * as keenable from './provider/backends/keenable.mjs'
import * as anysearch from './provider/backends/anysearch.mjs'
import * as exa from './provider/backends/exa.mjs'

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
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--backend') only = args[++i]
  else if (args[i] === '--fetch') fetchUrl = args[++i]
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
  endpoint: { keenable: DEFAULTS.keenableEndpoint, anysearch: DEFAULTS.anysearchEndpoint, exa: DEFAULTS.exaEndpoint }[id] ?? '',
})

const pad = (text, width) => String(text).padEnd(width)
const ms = (n) => `${n.toFixed(0)}ms`

async function run(query) {
  console.log(`\nquery: ${query}`)
  console.log(`${pad('backend', 10)} ${pad('latency', 9)} ${pad('sources', 8)} status`)
  const lists = []
  for (const [id, backend] of Object.entries(BACKENDS)) {
    if (only && only !== id) continue
    if (backend.available(settings(id)) === false) {
      console.log(`${pad(id, 10)} ${pad('-', 9)} ${pad('-', 8)} skipped (no key)`)
      continue
    }
    const started = performance.now()
    try {
      const sources = await backend.search({ query, maxResults: 8, signal: AbortSignal.timeout(DEFAULTS.timeoutMs), settings: settings(id) })
      console.log(`${pad(id, 10)} ${pad(ms(performance.now() - started), 9)} ${pad(sources.length, 8)} ok`)
      for (const source of sources.slice(0, 3)) console.log(`  - ${(source.title || source.url).slice(0, 76)}`)
      if (sources.length) lists.push(sources)
    } catch (error) {
      console.log(`${pad(id, 10)} ${pad(ms(performance.now() - started), 9)} ${pad('-', 8)} FAILED ${error.message}`)
    }
  }
  if (lists.length) {
    console.log('  fused:')
    for (const source of fuse(lists, 5)) console.log(`  = ${(source.title || source.url).slice(0, 76)}`)
  } else {
    console.log('  fused: nothing (every backend failed or returned nothing)')
  }
}

if (fetchUrl) {
  const started = performance.now()
  if (apiKey) {
    try {
      const page = await tinyfish.fetchPage({ url: fetchUrl }, settings('tinyfish'))
      console.log(`tinyfish fetch: ${ms(performance.now() - started)}, ${page.body.content.length} chars, ${page.body.kind}`)
    } catch (error) {
      console.log(`tinyfish fetch: FAILED ${error.message}`)
    }
  } else {
    console.log('tinyfish fetch: skipped (no key)')
  }
  const directStart = performance.now()
  try {
    const response = await fetch(fetchUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
    const body = await response.text()
    console.log(`direct fetch:   ${ms(performance.now() - directStart)}, HTTP ${response.status}, ${body.length} chars, ${response.headers.get('content-type') || 'no content-type'}`)
  } catch (error) {
    console.log(`direct fetch:   FAILED ${error.message}`)
  }
} else {
  for (const query of queries.length ? queries : ['cordis plugin loader patch yml', 'tinyfish search api pricing', 'deepseek harness agent preset']) {
    await run(query)
  }
}
