import { callTool } from '../mcp.mjs'
import { toSources } from '../backend.mjs'

/**
 * Exa — the official keyless MCP tier: no API key, no sign-in, free at a rate limit.
 *
 * Contract (verified 2026-11 against https://exa.ai/docs/get-started/exa-mcp):
 *   MCP streamable HTTP at https://mcp.exa.ai/mcp, tools `web_search_exa` / `web_fetch_exa`.
 *   The search tool answers as text blocks of "Title: / URL: / Published: / Author:".
 *
 * Keyless calls need a direct IPv4 route: proxied or IPv6-only paths answer 403. That is a
 * property of the vendor's free tier, so this backend is simply skipped when it refuses.
 */
/** Ranking trust, measured with `node probe.mjs --bench`; see README. */
export const trust = 1.0

export const id = 'exa'
export const title = 'Exa'

export const available = () => true

export async function search({ query, maxResults, signal, settings }) {
  const result = await callTool(settings.endpoint, 'web_search_exa', { query, numResults: maxResults || 8 }, signal)
  return parseBlocks(result)
}

/** One page as markdown text, keyless. Used as the second hop of the fetch chain. */
export async function fetchPage({ url, signal }, settings) {
  const result = await callTool(settings.endpoint, 'web_fetch_exa', { urls: [url], maxCharacters: 200_000 }, signal)
  const text = Array.isArray(result?.content)
    ? result.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    : ''
  if (!text.trim()) throw new Error(`Exa returned no content for ${url}`)
  const final = text.match(/^URL:\s*(\S+)\s*$/m)?.[1]
  return {
    url: final && /^https?:\/\//.test(final) ? final : url,
    statusCode: 200,
    body: { kind: 'text', content: text.slice(0, 200_000) },
    truncated: text.length > 200_000,
  }
}

/** Turn Exa's text blocks into sources; anything without a URL is dropped, as everywhere else. */
function parseBlocks(result) {
  const text = Array.isArray(result?.content)
    ? result.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    : ''
  if (!text.trim()) return []
  const blocks = text.split(/^Title:\s*/m).filter((block) => block.trim())
  const rows = blocks.map((block) => {
    const lines = block.split(/\r?\n/)
    const title = lines[0]?.trim()
    const field = (name) => {
      const match = block.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))
      return match?.[1]?.trim()
    }
    const highlights = block.split(/^Highlights:\s*$/m)[1] || ''
    const published = field('Published')
    return {
      title,
      url: field('URL'),
      snippet: highlights.replace(/\s+/g, ' ').trim().slice(0, 800),
      publishedAt: published && published !== 'N/A' ? published : undefined,
    }
  })
  return toSources(rows, { date: 'publishedAt' })
}
