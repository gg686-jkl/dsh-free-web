/**
 * The smallest MCP client that a search backend needs: a streamable-HTTP JSON-RPC call.
 *
 * Some keyless search tiers are published only as MCP servers (Exa is one). That is a
 * transport detail of the backend, not a tool the model ever sees: this module speaks the
 * protocol so the backend can answer like any other, and nothing is exposed on `ctx.web`
 * beyond the ordinary search provider.
 */

const PROTOCOL_VERSION = '2024-11-05'

/** Read the JSON-RPC result out of either a plain JSON body or one SSE `data:` frame. */
function readRpc(text) {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('empty response')
  if (trimmed.startsWith('{')) {
    const message = JSON.parse(trimmed)
    if (message.error) throw new Error(message.error.message || JSON.stringify(message.error))
    return message.result
  }
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const message = JSON.parse(payload)
      if (message.error) throw new Error(message.error.message || JSON.stringify(message.error))
      if (message.result !== undefined) return message.result
    } catch (error) {
      if (String(error?.message || '').startsWith('{')) throw error
      // A frame that is not JSON is not an answer; keep looking.
    }
  }
  throw new Error('no JSON-RPC result in the response')
}

async function post(endpoint, body, signal, sessionId) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (sessionId) headers['mcp-session-id'] = sessionId
  let response
  try {
    response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal })
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error('timed out')
    throw error
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  return { result: readRpc(text), sessionId: response.headers.get('mcp-session-id') || sessionId }
}

/** Sessions are cheap but not free; one per process is enough, renewed when it goes stale. */
const sessions = new Map()

export async function callTool(endpoint, tool, args, signal) {
  const open = async () => {
    const { sessionId } = await post(
      endpoint,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-web', version: '1.2.0' } },
      },
      signal,
    )
    if (sessionId) sessions.set(endpoint, sessionId)
    return sessionId
  }

  const invoke = async (sessionId) =>
    post(
      endpoint,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
      signal,
      sessionId,
    )

  let sessionId = sessions.get(endpoint)
  if (!sessionId) sessionId = await open()
  try {
    const { result } = await invoke(sessionId)
    return result
  } catch (error) {
    // A stale session is the one failure worth retrying once; anything else is the answer.
    sessions.delete(endpoint)
    const renewed = await open()
    const { result } = await invoke(renewed)
    return result
  }
}
