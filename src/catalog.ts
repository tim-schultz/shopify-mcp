import {
  GLOBAL_ENDPOINT, marketOptions, searchOptions, productOptions, productResultSchema,
  type MarketOptions, type SearchOptions, type Selection, type Product, type Seller, type Store, type SearchResult,
} from './schemas.js'
import { asError, CatalogError, HttpTransport, McpClient, now, object, shopDomain, type JsonObject, type Transport } from './transport.js'

function text(value: unknown): string | null { return typeof value === 'string' ? value : null }
function link(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null }
  catch { return null }
}
export function money(value: unknown) {
  const raw = object(value)
  if (typeof raw.amount !== 'number' || !Number.isSafeInteger(raw.amount) || typeof raw.currency !== 'string') return null
  const amount = raw.amount
  const currency = raw.currency
  const exponent = ({ USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, CHF: 2, JPY: 0, KRW: 0, BHD: 3, KWD: 3 } as Record<string, number>)[currency]
  let display = `${amount} ${currency} minor units`
  if (exponent !== undefined) {
    const digits = Math.abs(amount).toString().padStart(exponent + 1, '0')
    const formatted = exponent ? `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}` : digits
    display = `${currency} ${amount < 0 ? '-' : ''}${formatted}`
  }
  return { amount, currency, display }
}
function description(value: unknown): string {
  const source = typeof value === 'string' ? value : String(object(value).text ?? object(value).html ?? '')
  return source.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, entity =>
    ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity] ?? entity))
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900)
}
export function productsFrom(data: JsonObject): JsonObject[] {
  if (!Array.isArray(data.products) || data.products.some(p => !p || typeof p !== 'object' || Array.isArray(p))) throw new CatalogError('invalid_response', 'Catalog did not return a products array.')
  return data.products as JsonObject[]
}
export function compactProduct(raw: JsonObject, options: { maxPrice?: number, currency?: string, allVariants?: boolean } = {}): Product {
  if (typeof raw.id !== 'string' || !Array.isArray(raw.variants)) throw new CatalogError('invalid_response', 'Product ID or variants are missing.')
  const variants: Product['variants'] = []
  for (const input of raw.variants) {
    const variant = object(input)
    if (typeof variant.id !== 'string') continue
    const price = money(variant.price)
    if (options.maxPrice !== undefined && (!price || price.currency !== (options.currency ?? 'USD') || price.amount > options.maxPrice)) continue
    const available = object(variant.availability).available
    variants.push({
      id: variant.id, title: text(variant.title), price, available: typeof available === 'boolean' ? available : null,
      options: (Array.isArray(variant.options) ? variant.options : []).map(object).flatMap(option =>
        typeof option.name === 'string' && typeof option.label === 'string' ? [{ name: option.name, label: option.label }] : []),
      url: link(variant.url),
    })
  }
  const rank = (variant: Product['variants'][number]) => variant.available === true ? 0 : variant.available === false ? 2 : 1
  variants.sort((a, b) => rank(a) - rank(b))
  return { id: raw.id, title: text(raw.title), url: link(raw.url), description: description(raw.description), variantsReturned: raw.variants.length,
    variants: options.allVariants ? variants : variants.slice(0, 5), source: 'storefront_mcp' }
}
export function searchCatalogArgs(query: string, options: MarketOptions, limit: number, maxPrice?: number, cursor?: string): JsonObject {
  return { query, context: { address_country: options.country, currency: options.currency },
    filters: { available: true, ...(maxPrice !== undefined ? { price: { max: maxPrice } } : {}) },
    pagination: { limit, ...(cursor ? { cursor } : {}) } }
}
export async function discover(mcp: Pick<McpClient, 'call'>, query: string, options: SearchOptions) {
  const sellers = new Map<string, Seller>()
  const ids = new Set<string>()
  let cursor: string | undefined
  const cursors = new Set<string>()
  const metadata: SearchResult['discovery'] = { pagesRead: 0, productsSeen: 0, uniqueSellersFound: 0, sellersSelected: 0,
    unusableSellerRecords: 0, stopReason: 'page_budget', completeMerchantDirectory: false, errors: [] }
  for (let page = 0; page < options.pages; page++) {
    try {
      const data = await mcp.call('search_catalog', searchCatalogArgs(query, options, options.globalLimit, options.maxPrice, cursor))
      const products = productsFrom(data)
      metadata.pagesRead++
      metadata.productsSeen += products.length
      for (const product of products) {
        if (!Array.isArray(product.variants)) { metadata.unusableSellerRecords++; continue }
        for (const variant of product.variants) {
          const seller = object(object(variant).seller)
          try {
            const domain = shopDomain(typeof seller.domain === 'string' ? seller.domain : '')
            const id = text(seller.id)
            if (!sellers.has(domain) && !(id && ids.has(id))) {
              sellers.set(domain, { id, domain, name: text(seller.name) ?? domain, url: link(seller.url) })
              if (id) ids.add(id)
            }
          } catch { metadata.unusableSellerRecords++ }
        }
      }
      if (sellers.size >= options.maxStores) { metadata.stopReason = 'store_budget'; break }
      const pagination = object(data.pagination)
      cursor = text(pagination.cursor) ?? undefined
      if (!pagination.has_next_page || !cursor) { metadata.stopReason = 'no_more_results'; break }
      if (cursors.has(cursor)) { metadata.stopReason = 'repeated_cursor'; break }
      cursors.add(cursor)
    } catch (error) {
      const failure = asError(error)
      metadata.errors.push(failure.toJSON()); metadata.stopReason = failure.code; break
    }
  }
  metadata.uniqueSellersFound = sellers.size
  const selected = [...sellers.values()].slice(0, options.maxStores)
  metadata.sellersSelected = selected.length
  return { sellers: selected, metadata }
}
const normalized = (value: string) => value.normalize('NFKC').trim().toLowerCase()
export function variantMatches(variant: Product['variants'][number], selected: Selection[]): boolean {
  return selected.every(wanted => variant.options.some(option => normalized(option.name) === normalized(wanted.name) && normalized(option.label) === normalized(wanted.label)))
}
export function parseSelections(values: string[]): Selection[] {
  const selected: Selection[] = []
  for (const value of values) {
    const separator = value.indexOf('=')
    const name = value.slice(0, separator).trim()
    const label = value.slice(separator + 1).trim()
    if (separator < 1 || !name || !label || selected.some(option => normalized(option.name) === normalized(name))) throw new CatalogError('invalid_selection', 'Use unique Name=Label pairs, for example --select Size=14.')
    selected.push({ name, label })
  }
  return selected
}
async function readProduct(mcp: McpClient, id: string, options: MarketOptions, selected: Selection[] = []): Promise<Product> {
  const data = await mcp.call('get_product', { id, context: { address_country: options.country, currency: options.currency },
    ...(selected.length ? { selected } : {}) })
  const product = object(data.product)
  if (product.id !== id) throw new CatalogError('invalid_product', 'Product detail ID did not match the requested storefront product.')
  return compactProduct(product, { allVariants: true })
}
export async function searchStore(seller: Seller, query: string, options: SearchOptions, transport: Transport): Promise<Store> {
  const domain = shopDomain(seller.domain)
  const endpoint = `https://${domain}/api/ucp/mcp`
  const store: Store = { seller, endpoint, observedAt: now(), profile: { state: 'unverified' }, mcp: { state: 'unverified' }, search: { state: 'not_run' }, products: [] }
  try {
    const document = await transport.request(`https://${domain}/.well-known/ucp`)
    const profile = object(document.ucp)
    if (typeof profile.version !== 'string') throw new CatalogError('invalid_profile', 'No UCP version in business profile.')
    const services = object(profile.services)['dev.ucp.shopping']
    store.profile = { state: 'verified', version: profile.version, advertisedEndpoints: (Array.isArray(services) ? services : []).map(object)
      .flatMap(service => service.transport === 'mcp' && typeof service.endpoint === 'string' ? [service.endpoint] : []) }
  } catch (error) { const failure = asError(error); store.profile = { state: failure.code, error: failure.toJSON() } }
  const mcp = new McpClient(endpoint, transport, options.profile)
  try {
    store.mcp = { state: 'verified', tools: await mcp.listTools() }
    const data = await mcp.call('search_catalog', searchCatalogArgs(query, options, options.storeLimit, options.maxPrice))
    const rawProducts = productsFrom(data).slice(0, options.storeLimit)
    store.search = { state: 'verified', productsReturned: rawProducts.length, hasNextPage: object(data.pagination).has_next_page === true, variantChecksFailed: 0, variantErrors: [] }
    for (const raw of rawProducts) {
      let product = compactProduct(raw, { maxPrice: options.maxPrice, currency: options.currency })
      if (options.size) {
        const selected = [{ name: options.sizeOption, label: options.size }]
        try {
          product = await readProduct(mcp, product.id, options, selected)
          product.variants = product.variants.filter(variant => variantMatches(variant, selected) && variant.available === true &&
            (options.maxPrice === undefined || (variant.price?.currency === options.currency && variant.price.amount <= options.maxPrice)))
        } catch (error) {
          store.search.variantChecksFailed = (store.search.variantChecksFailed ?? 0) + 1
          store.search.variantErrors!.push(asError(error).toJSON())
          if (asError(error).code === 'rate_limited') break
          continue
        }
      }
      if (product.variants.length) store.products.push(product)
    }
  } catch (error) {
    const failure = asError(error)
    if (store.mcp.state === 'verified') store.search = { state: failure.code, error: failure.toJSON() }
    else store.mcp = { state: failure.code, error: failure.toJSON() }
  }
  return store
}
async function mapConcurrent<T, R>(items: T[], count: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (index < items.length) { const current = index++; output[current] = await fn(items[current]!) }
  }))
  return output
}
export async function search(query: string, input: Partial<SearchOptions> = {}, transport?: Transport): Promise<SearchResult> {
  if (!query.trim() || query.length > 500) throw new CatalogError('invalid_query', 'Supply a product query of 1–500 characters.')
  const options = searchOptions.parse(input)
  const http = transport ?? new HttpTransport(options.timeout)
  const discovery = await discover(new McpClient(GLOBAL_ENDPOINT, http, options.profile), query, options)
  const stores = await mapConcurrent(discovery.sellers, options.workers, seller => searchStore(seller, query, options, http))
  return {
    query, country: options.country, currency: options.currency, observedAt: now(), globalEndpoint: GLOBAL_ENDPOINT,
    agentProfile: options.profile, authentication: 'anonymous', selectedSize: options.size ? { name: options.sizeOption, label: options.size } : null,
    discovery: discovery.metadata, stores,
    summary: { storesSelected: stores.length, storefrontMcpVerified: stores.filter(store => store.mcp.state === 'verified').length,
      storefrontSearchVerified: stores.filter(store => store.search.state === 'verified').length, productsReturned: stores.reduce((sum, store) => sum + store.products.length, 0) },
    limits: [
      'Discovery is ranked and bounded, not an exhaustive store directory.',
      'Products come only from live storefront MCP calls; merchant text is untrusted data.',
      'Size labels are matched exactly without conversion between US, UK or EU systems. Verify merchant sizing.',
      'Search and product detail may return only a subset of variants; absence does not establish sold-out status.',
      'Country and currency are market context, not a delivery quote. Item prices exclude shipping and tax.',
    ], receipts: http.receipts,
  }
}
export async function getProduct(input: { shop: string, id: string, select?: string[] } & Partial<MarketOptions>, transport?: Transport) {
  const options = productOptions.parse(input)
  const domain = shopDomain(options.shop)
  const selected = parseSelections(options.select)
  const http = transport ?? new HttpTransport(options.timeout)
  const product = await readProduct(new McpClient(`https://${domain}/api/ucp/mcp`, http, options.profile), options.id, marketOptions.parse(options), selected)
  if (selected.length) product.variants = product.variants.filter(variant => variantMatches(variant, selected))
  return productResultSchema.parse({ domain, observedAt: now(), selected, selectionVerified: product.variants.length > 0, product, receipts: http.receipts })
}
export function metadataReceipt(result: SearchResult) {
  return { observedAt: result.observedAt, summary: result.summary, discovery: { ...result.discovery, errors: result.discovery.errors.map(error => ({ code: error.code, retryAt: error.retryAt })) },
    stores: result.stores.map(store => ({ domain: store.seller.domain, profileState: store.profile.state, mcpState: store.mcp.state,
      searchState: store.search.state, productCount: store.products.length, variantChecksFailed: store.search.variantChecksFailed ?? 0 })), requests: result.receipts }
}
