import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactProduct, discover, getProduct, metadataReceipt, money, parseSelections, search } from '../src/catalog.js'
import { searchOptions } from '../src/schemas.js'
import { CatalogError, object, type JsonObject, type Transport } from '../src/transport.js'

const seller = (name = 'alpha') => ({ id: name, name, domain: `${name}.myshopify.com`, url: `https://${name}.example` })
const variant = (size: string, available: unknown = true) => ({ id: `variant-${size}`, title: size, options: [{ name: 'Size', label: size }], price: { amount: 12500, currency: 'USD' }, availability: { available } })
const product = (variants = [variant('9'), variant('14')]) => ({ id: 'gid://shopify/Product/12', title: 'Synthetic trail shoe', description: '<p>Fixture only</p>', url: 'https://merchant.example/products/shoe', variants })

class Fixture implements Transport {
  receipts = []
  calls: { domain: string, method: string, tool?: string, catalog?: JsonObject }[] = []
  blocked?: string
  failedSearch?: string
  brokenProfile?: string
  detailVariants = [variant('14')]
  wrongId = false
  async request(endpoint: string, body?: JsonObject): Promise<JsonObject> {
    const domain = new URL(endpoint).hostname
    if (!body) {
      if (this.brokenProfile === domain) throw new CatalogError('endpoint_not_found', 'HTTP 404')
      return { ucp: { version: '2026-08-25' } }
    }
    const params = object(body.params)
    const args = object(params.arguments)
    this.calls.push({ domain, method: String(body.method), tool: typeof params.name === 'string' ? params.name : undefined, catalog: object(args.catalog) })
    if (this.blocked === domain) throw new CatalogError('authentication_required', 'HTTP 403')
    if (body.method === 'tools/list') return { result: { tools: ['search_catalog', 'get_product', 'create_cart'].map(name => ({ name, inputSchema: { required: ['catalog', 'meta'] } })) } }
    if (domain === 'catalog.shopify.com') return { result: { structuredContent: { products: [{ id: 'global-only', variants: ['alpha', 'beta'].map(name => ({ seller: seller(name) })) }] } } }
    if (params.name === 'get_product') return { result: { structuredContent: { product: { ...product(this.detailVariants), ...(this.wrongId ? { id: 'wrong' } : {}) } } } }
    if (this.failedSearch === domain) throw new CatalogError('rate_limited', 'HTTP 429', '2099-01-01T00:00:00Z')
    return { result: { content: [{ type: 'text', text: JSON.stringify({ products: [product()] }) }] } }
  }
}
test('discovery paginates and deduplicates multi-merchant offers', async () => {
  let calls = 0
  const pages = [
    { products: [{ variants: [{ seller: seller() }, { seller: seller() }] }], pagination: { has_next_page: true, cursor: 'next' } },
    { products: [{ variants: [{ seller: seller() }, { seller: seller('beta') }] }] },
  ]
  const client = { async call(_name: string, catalog: JsonObject) { if (calls === 1) assert.equal(object(catalog.pagination).cursor, 'next'); return pages[calls++]! } }
  const result = await discover(client, 'shoes', searchOptions.parse({ maxStores: 2 }))
  assert.equal(result.metadata.pagesRead, 2)
  assert.deepEqual(result.sellers.map(s => s.domain), ['alpha.myshopify.com', 'beta.myshopify.com'])
})
test('repeated cursors stop bounded discovery', async () => {
  let calls = 0
  const result = await discover({ async call() { calls++; return { products: [], pagination: { has_next_page: true, cursor: 'repeat' } } } }, 'shoes', searchOptions.parse({ pages: 10 }))
  assert.equal(result.metadata.stopReason, 'repeated_cursor')
  assert.equal(calls, 2)
})
test('invalid and missing seller records do not erase valid merchants', async () => {
  const result = await discover({ async call() { return { products: [{ variants: [null, {}, { seller: { domain: 'metadata.internal' } }, { seller: seller() }] }] } } }, 'shoes', searchOptions.parse({}))
  assert.equal(result.sellers.length, 1)
  assert.equal(result.metadata.unusableSellerRecords, 3)
})
test('only merchant results are returned while blocked sellers remain visible', async () => {
  const http = new Fixture(); http.blocked = 'beta.myshopify.com'
  const result = await search('shoes', { maxStores: 2 }, http)
  assert.equal(result.summary.storefrontSearchVerified, 1)
  assert.equal(result.stores[1]?.mcp.state, 'authentication_required')
  assert.equal(result.stores[0]?.products[0]?.id, 'gid://shopify/Product/12')
  assert.ok(!JSON.stringify(result.stores.flatMap(s => s.products)).includes('global-only'))
})
test('failed storefront search never falls back to global products', async () => {
  const http = new Fixture(); http.failedSearch = 'alpha.myshopify.com'
  const result = await search('shoes', {}, http)
  assert.equal(result.stores[0]?.search.state, 'rate_limited')
  assert.deepEqual(result.stores[0]?.products, [])
  assert.equal(result.summary.storefrontSearchVerified, 1)
})
test('a broken UCP profile does not hide a working native MCP endpoint', async () => {
  const http = new Fixture(); http.brokenProfile = 'alpha.myshopify.com'
  const result = await search('shoes', {}, http)
  assert.equal(result.stores[0]?.profile.state, 'endpoint_not_found')
  assert.equal(result.stores[0]?.search.state, 'verified')
})
test('size search sends selected options and checks actual stock', async () => {
  const http = new Fixture()
  const result = await search('trail shoes', { size: '14' }, http)
  assert.equal(result.summary.productsReturned, 2)
  const details = http.calls.filter(call => call.tool === 'get_product')
  assert.deepEqual(details[0]?.catalog?.selected, [{ name: 'Size', label: '14' }])
  assert.ok(result.stores.every(store => store.products[0]?.variants.every(v => v.options[0]?.label === '14' && v.available)))
})
test('a fallback size, unknown stock, or out-of-stock selection is never promoted to a match', async () => {
  for (const variants of [[variant('9')], [variant('14', false)], [variant('14', 'yes')]]) {
    const http = new Fixture(); http.detailVariants = variants
    const result = await search('trail shoes size 14', { size: '14' }, http)
    assert.equal(result.summary.productsReturned, 0)
  }
})
test('product detail preserves sold-out stock and rejects a mismatched product ID', async () => {
  const http = new Fixture(); http.detailVariants = [variant('14', false)]
  const result = await getProduct({ shop: 'alpha.myshopify.com', id: 'gid://shopify/Product/12', select: ['Size=14'] }, http)
  assert.equal(result.selectionVerified, true)
  assert.equal(result.product.variants[0]?.available, false)
  http.wrongId = true
  await assert.rejects(getProduct({ shop: 'alpha.myshopify.com', id: 'gid://shopify/Product/12' }, http), { code: 'invalid_product' })
})
test('selection parsing supports labels containing equals and rejects duplicate or empty names', () => {
  assert.deepEqual(parseSelections(['Size=14', 'Style=A=B']), [{ name: 'Size', label: '14' }, { name: 'Style', label: 'A=B' }])
  for (const values of [['Size'], ['Size='], ['=14'], ['Size=14', 'size=9']]) assert.throws(() => parseSelections(values), { code: 'invalid_selection' })
})
test('money preserves minor units, currencies, and unknown exponents', () => {
  assert.equal(money({ amount: 5800, currency: 'USD' })?.display, 'USD 58.00')
  assert.equal(money({ amount: 5800, currency: 'JPY' })?.display, 'JPY 5800')
  assert.equal(money({ amount: 5800, currency: 'KWD' })?.display, 'KWD 5.800')
  assert.equal(money({ amount: 5800, currency: 'XYZ' })?.display, '5800 XYZ minor units')
  assert.equal(money({ amount: true, currency: 'USD' }), null)
  assert.equal(money({ amount: Number.MAX_SAFE_INTEGER + 1, currency: 'USD' }), null)
})
test('price caps never compare amounts across currencies; missing stock stays unknown', () => {
  const raw = product([variant('9', 'yes'), { ...variant('14'), price: { amount: 100, currency: 'JPY' } }])
  const p = compactProduct(raw, { maxPrice: 13000, currency: 'USD' })
  assert.equal(p.variants.length, 1)
  assert.equal(p.variants[0]?.available, null)
})
test('metadata receipt excludes query, products, descriptions, prices and variant identifiers', async () => {
  const receipt = JSON.stringify(metadataReceipt(await search('private query', {}, new Fixture())))
  for (const value of ['private query', 'Synthetic trail shoe', 'gid://shopify/Product/12', 'amount', 'Fixture only', 'variant-14']) assert.ok(!receipt.includes(value), value)
})
