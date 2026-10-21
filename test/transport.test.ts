import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpTransport, McpClient, parseRpc, safeEndpoint, type JsonObject } from '../src/transport.js'
import { GLOBAL_ENDPOINT } from '../src/schemas.js'

test('only canonical HTTPS catalog endpoints can reach transport', () => {
  assert.equal(safeEndpoint(GLOBAL_ENDPOINT), GLOBAL_ENDPOINT)
  for (const url of ['http://a.myshopify.com/api/ucp/mcp', 'https://127.0.0.1/api/ucp/mcp',
    'https://a.myshopify.com.attacker.test/api/ucp/mcp', 'https://a.myshopify.com/private',
    'https://user:pass@a.myshopify.com/api/ucp/mcp', 'https://a.myshopify.com:443/api/ucp/mcp',
    'https://a.myshopify.com/api/ucp/mcp?secret=yes', 'https://a.myshopify.com/api/ucp/mcp#fragment']) {
    assert.throws(() => safeEndpoint(url), { code: 'unsafe_endpoint' })
  }
})
test('cart, checkout and order tools are blocked before any requests', async () => {
  let calls = 0
  const client = new McpClient(GLOBAL_ENDPOINT, { receipts: [], async request() { calls++; return {} } })
  for (const name of ['create_cart', 'get_cart', 'complete_checkout', 'get_order', 'cancel_checkout']) {
    await assert.rejects(client.call(name, {}), { code: 'operation_blocked' })
  }
  assert.equal(calls, 0)
})
test('SSE skips notifications and requires a matching JSON-RPC id', () => {
  const reply = { jsonrpc: '2.0', id: 'expected', result: {} }
  const raw = `data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: ${JSON.stringify(reply)}\n\n`
  assert.deepEqual(parseRpc(raw, 'text/event-stream', 'expected'), reply)
  assert.throws(() => parseRpc(JSON.stringify(reply), 'application/json', 'wrong'), { code: 'protocol_error' })
})
test('streaming response handles split frames and cancels after its reply', async () => {
  let canceled = false
  const encoder = new TextEncoder()
  const frames = [
    'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0",',
    '"id":"one","result":{}}\n\n',
  ]
  const stream = new ReadableStream({
    pull(controller) { const chunk = frames.shift(); if (chunk) controller.enqueue(encoder.encode(chunk)) },
    cancel() { canceled = true },
  })
  const transport = new HttpTransport(3, async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  const reply = await transport.request(GLOBAL_ENDPOINT, { id: 'one', method: 'tools/list' })
  assert.deepEqual(reply.result, {})
  assert.equal(canceled, true)
})
test('HTTP 429 uses Retry-After, blocks repeats and keeps metadata only', async () => {
  let calls = 0
  const transport = new HttpTransport(3, async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '90' } }) })
  for (let i = 0; i < 2; i++) await assert.rejects(transport.request(GLOBAL_ENDPOINT, { id: 'one', method: 'tools/list' }), { code: 'rate_limited' })
  assert.equal(calls, 1)
  assert.equal(transport.receipts[0]?.http, 429)
  assert.equal(transport.receipts[0]?.errorCode, 'rate_limited')
})
test('redirect targets are never followed', async () => {
  const transport = new HttpTransport(3, async (_url, init) => {
    assert.equal(init?.redirect, 'manual')
    return new Response('', { status: 302, headers: { location: 'https://attacker.test' } })
  })
  await assert.rejects(transport.request(GLOBAL_ENDPOINT), { code: 'redirect_blocked' })
})
test('malformed and oversized responses produce explicit errors', async () => {
  const malformed = new HttpTransport(3, async () => new Response('broken'))
  await assert.rejects(malformed.request(GLOBAL_ENDPOINT), { code: 'transport_error' })
  const oversized = new HttpTransport(3, async () => new Response('x'.repeat(4_000_001)))
  await assert.rejects(oversized.request(GLOBAL_ENDPOINT), { code: 'response_limit' })
})
test('MCP text content and schema drift are handled without trusting remote tool descriptions', async () => {
  const requests: JsonObject[] = []
  const client = new McpClient(GLOBAL_ENDPOINT, { receipts: [], async request(_url, body) {
    requests.push(body!)
    return { result: body?.method === 'tools/list' ? { tools: [{ name: 'search_catalog', inputSchema: { required: ['meta', 'catalog', 'newRequiredField'] } }] } : {} }
  } })
  await assert.rejects(client.call('search_catalog', { query: 'shoes' }), { code: 'schema_changed' })
  assert.equal(requests.length, 1)
})
