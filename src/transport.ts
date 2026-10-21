import { randomUUID } from 'node:crypto'
import { z } from 'incur'
import { DEFAULT_PROFILE, type ErrorInfo, type Receipt } from './schemas.js'

const SHOP = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/
const ENDPOINT = /^https:\/\/(?:catalog\.shopify\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com)\/(?:api\/ucp\/mcp|\.well-known\/ucp)$/
const READ_TOOLS = new Set(['search_catalog', 'get_product', 'lookup_catalog'])
export const now = () => new Date().toISOString()
export type JsonObject = Record<string, unknown>
export function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}
export class CatalogError extends Error {
  constructor(public code: string, message: string, public retryAt?: string) { super(message); this.name = 'CatalogError' }
  toJSON(): ErrorInfo { return { code: this.code, message: this.message, ...(this.retryAt ? { retryAt: this.retryAt } : {}) } }
}
export function asError(error: unknown): CatalogError {
  return error instanceof CatalogError ? error : new CatalogError('invalid_response', 'Catalog returned an unexpected document.')
}
export function shopDomain(value: string): string {
  const domain = value.trim().toLowerCase()
  if (!SHOP.test(domain)) throw new CatalogError('unsupported_domain', 'Use a canonical seller.myshopify.com domain.')
  return domain
}
export function safeEndpoint(value: string): string {
  if (!ENDPOINT.test(value)) throw new CatalogError('unsafe_endpoint', 'Only canonical Shopify discovery and MCP endpoints are allowed.')
  return value
}

export interface Transport {
  receipts: Receipt[]
  request(endpoint: string, body?: JsonObject): Promise<JsonObject>
}
const rpcSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.unknown() }).passthrough()
function rpcReply(value: unknown, id: string): JsonObject {
  const parsed = rpcSchema.safeParse(value)
  if (!parsed.success || parsed.data.id !== id) throw new CatalogError('protocol_error', 'No matching JSON-RPC response.')
  return parsed.data
}
export function parseRpc(raw: string, contentType: string, id: string): JsonObject {
  if (!contentType.includes('text/event-stream')) return rpcReply(JSON.parse(raw), id)
  for (const frame of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') continue
    const value: unknown = JSON.parse(data)
    if (object(value).id === id) return rpcReply(value, id)
  }
  throw new CatalogError('protocol_error', 'No matching JSON-RPC response.')
}
async function readResponse(response: Response, id?: string): Promise<JsonObject> {
  const reader = response.body?.getReader()
  if (!reader) throw new CatalogError('invalid_response', 'Endpoint returned no response body.')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const sse = response.headers.get('content-type')?.includes('text/event-stream') ?? false
  let bytes = 0
  let raw = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 4_000_000) throw new CatalogError('response_limit', 'Response exceeded 4 MB.')
      raw += decoder.decode(next.value, { stream: true })
      const normalized = raw.replace(/\r\n/g, '\n')
      if (sse && id && normalized.includes('\n\n')) {
        try { return parseRpc(normalized.slice(0, normalized.lastIndexOf('\n\n') + 2), 'text/event-stream', id) }
        catch (error) { if (!(error instanceof CatalogError) || error.code !== 'protocol_error') throw error }
      }
    }
    raw += decoder.decode()
    const value: unknown = id ? parseRpc(raw, sse ? 'text/event-stream' : 'application/json', id) : JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CatalogError('invalid_response', 'Endpoint returned a non-object document.')
    return value as JsonObject
  } finally { await reader.cancel().catch(() => {}) }
}

export class HttpTransport implements Transport {
  receipts: Receipt[] = []
  private cooldowns = new Map<string, number>()
  constructor(private timeout = 20, private fetcher: typeof fetch = fetch) {}
  async request(endpoint: string, body?: JsonObject): Promise<JsonObject> {
    safeEndpoint(endpoint)
    const operation = String(object(body?.params).name ?? body?.method ?? 'discovery')
    const key = `${endpoint}:${operation}`
    const cooldown = this.cooldowns.get(key) ?? 0
    if (cooldown > Date.now()) throw new CatalogError('rate_limited', 'Provider cooldown is active.', new Date(cooldown).toISOString())
    const start = Date.now()
    let status: number | null = null
    let errorCode: string | undefined
    try {
      const response = await this.fetcher(endpoint, {
        method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(this.timeout * 1000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': 'ShopifyProductSearch/0.1.0' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      status = response.status
      if (!response.ok) {
        await response.body?.cancel()
        if (status >= 300 && status < 400) throw new CatalogError('redirect_blocked', 'Endpoint redirected; redirect target was not requested.')
        if (status === 429) {
          const retry = response.headers.get('retry-after') ?? '60'
          const deadline = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry)
          const safeDeadline = Number.isFinite(deadline) && deadline <= 8.64e15 ? Math.max(Date.now(), deadline) : Date.now() + 60_000
          this.cooldowns.set(key, safeDeadline)
          throw new CatalogError('rate_limited', 'HTTP 429; no automatic retry.', new Date(safeDeadline).toISOString())
        }
        throw new CatalogError([401, 403].includes(status) ? 'authentication_required' : status === 404 ? 'endpoint_not_found' : 'http_error', `Endpoint returned HTTP ${status}.`)
      }
      const reply = await readResponse(response, typeof body?.id === 'string' ? body.id : undefined)
      if (body && reply.error) {
        const message = String(object(reply.error).message ?? 'JSON-RPC error')
        if (/rate/i.test(message) && /limit/i.test(message)) {
          const deadline = Date.now() + 60_000
          this.cooldowns.set(key, deadline)
          throw new CatalogError('rate_limited', 'Provider rate limit; no automatic retry.', new Date(deadline).toISOString())
        }
        throw new CatalogError('rpc_error', 'Provider returned a JSON-RPC error.')
      }
      return reply
    } catch (error) {
      const failure = error instanceof CatalogError ? error : new CatalogError('transport_error', 'Request failed or response could not be decoded.')
      errorCode = failure.code
      throw failure
    } finally {
      this.receipts.push({ endpoint, operation, http: status, observedAt: now(), elapsedMs: Date.now() - start, ...(errorCode ? { errorCode } : {}) })
    }
  }
}

const toolsSchema = z.array(z.object({ name: z.string(), inputSchema: z.unknown().optional() }).passthrough())
export class McpClient {
  private tools?: Map<string, z.infer<typeof toolsSchema>[number]>
  constructor(private endpoint: string, private transport: Transport, private profile = DEFAULT_PROFILE) { safeEndpoint(endpoint) }
  private async rpc(method: string, params: JsonObject): Promise<JsonObject> {
    const body = await this.transport.request(this.endpoint, { jsonrpc: '2.0', id: randomUUID(), method, params })
    if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) throw new CatalogError('protocol_error', 'MCP result is missing.')
    return body.result as JsonObject
  }
  async listTools(): Promise<string[]> {
    const result = await this.rpc('tools/list', { arguments: { meta: { 'ucp-agent': { profile: this.profile } } } })
    const parsed = toolsSchema.safeParse(result.tools)
    if (!parsed.success) throw new CatalogError('protocol_error', 'Invalid MCP tool listing.')
    this.tools = new Map(parsed.data.map(tool => [tool.name, tool]))
    return [...this.tools.keys()]
  }
  async call(name: string, catalog: JsonObject): Promise<JsonObject> {
    if (!READ_TOOLS.has(name)) throw new CatalogError('operation_blocked', 'Only catalog reads are allowed.')
    if (!this.tools) await this.listTools()
    const tool = this.tools!.get(name)
    if (!tool) throw new CatalogError('tool_not_exposed', `Endpoint does not expose ${name}.`)
    const args = { catalog, meta: { 'ucp-agent': { profile: this.profile } } }
    const schema = object(tool.inputSchema)
    const catalogSchema = object(object(schema.properties).catalog)
    for (const [required, supplied] of [[schema.required, args], [catalogSchema.required, catalog]] as const) {
      if (Array.isArray(required) && required.some(key => typeof key !== 'string' || !(key in supplied))) throw new CatalogError('schema_changed', 'Provider requires additional arguments; inspect its current schema.')
    }
    const reply = await this.rpc('tools/call', { name, arguments: args })
    if (reply.isError) throw new CatalogError('tool_error', `${name} returned an MCP tool error.`)
    let data: unknown = reply.structuredContent
    if (data === undefined) {
      const blocks = Array.isArray(reply.content) ? reply.content : []
      const text = blocks.map(object).find(block => block.type === 'text' && typeof block.text === 'string')?.text
      try { data = typeof text === 'string' ? JSON.parse(text) : undefined }
      catch { throw new CatalogError('invalid_response', 'Catalog result did not contain JSON.') }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CatalogError('invalid_response', 'Catalog result was not an object.')
    return data as JsonObject
  }
}
