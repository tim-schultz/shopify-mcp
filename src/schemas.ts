import { z } from 'incur'

export const DEFAULT_PROFILE = 'https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json'
export const GLOBAL_ENDPOINT = 'https://catalog.shopify.com/api/ucp/mcp'

const integer = (min: number, max: number, fallback: number) => z.number().int().min(min).max(max).default(fallback)
export const marketOptions = z.object({
  country: z.string().regex(/^[A-Z]{2}$/).default('US').describe('Country context; does not confirm delivery eligibility'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  timeout: integer(3, 60, 20).describe('Per-request timeout in seconds'),
  profile: z.url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  }, 'Agent profile must be an HTTPS URL without credentials').default(DEFAULT_PROFILE),
})
export const searchOptions = marketOptions.extend({
  maxStores: integer(1, 12, 6).describe('Maximum distinct merchants to verify'),
  pages: integer(1, 10, 4).describe('Maximum Global Catalog pages'),
  globalLimit: integer(1, 50, 30).describe('Global products per page'),
  storeLimit: integer(1, 10, 4).describe('Products per storefront'),
  workers: integer(1, 3, 3).describe('Maximum concurrent storefront searches'),
  maxPrice: z.number().int().min(0).max(100_000_000).optional().describe('Item-price cap in requested currency minor units; USD 100 = 10000'),
  size: z.string().trim().min(1).max(80).optional().describe('Exact merchant size label to verify using product detail; no size-system conversion'),
  sizeOption: z.string().trim().min(1).max(80).default('Size').describe('Merchant option name used with --size'),
})
export const productOptions = marketOptions.extend({
  shop: z.string().describe('Canonical seller.myshopify.com domain from search'),
  id: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/).describe('Storefront product ID; not a Global Catalog UPID'),
  select: z.array(z.string()).default([]).describe('Variant option as Name=Label; repeat for multiple options'),
})
export const selectionSchema = z.object({ name: z.string(), label: z.string() })
export const errorSchema = z.object({ code: z.string(), message: z.string(), retryAt: z.string().optional() })
export const receiptSchema = z.object({
  endpoint: z.string(), operation: z.string(), http: z.number().nullable(),
  observedAt: z.string(), elapsedMs: z.number(), errorCode: z.string().optional(),
})
export const stateSchema = z.object({
  state: z.string(), error: errorSchema.optional(), tools: z.array(z.string()).optional(),
})
export const moneySchema = z.object({ amount: z.number().int(), currency: z.string(), display: z.string() })
export const variantSchema = z.object({
  id: z.string(), title: z.string().nullable(), price: moneySchema.nullable(),
  available: z.boolean().nullable(), options: z.array(selectionSchema), url: z.string().nullable(),
})
export const productSchema = z.object({
  id: z.string(), title: z.string().nullable(), url: z.string().nullable(), description: z.string(),
  variantsReturned: z.number(), variants: z.array(variantSchema), source: z.literal('storefront_mcp'),
})
export const sellerSchema = z.object({
  id: z.string().nullable(), name: z.string(), domain: z.string(), url: z.string().nullable(),
})
export const discoverySchema = z.object({
  pagesRead: z.number(), productsSeen: z.number(), uniqueSellersFound: z.number(), sellersSelected: z.number(),
  unusableSellerRecords: z.number(), stopReason: z.string(), completeMerchantDirectory: z.literal(false), errors: z.array(errorSchema),
})
export const storeSchema = z.object({
  seller: sellerSchema, endpoint: z.string(), observedAt: z.string(),
  profile: stateSchema.extend({ version: z.string().optional(), advertisedEndpoints: z.array(z.string()).optional() }),
  mcp: stateSchema,
  search: stateSchema.extend({
    productsReturned: z.number().optional(), hasNextPage: z.boolean().optional(),
    variantChecksFailed: z.number().optional(), variantErrors: z.array(errorSchema).optional(),
  }),
  products: z.array(productSchema),
})
export const searchResultSchema = z.object({
  query: z.string(), country: z.string(), currency: z.string(), observedAt: z.string(),
  globalEndpoint: z.string(), agentProfile: z.string(), authentication: z.literal('anonymous'),
  selectedSize: selectionSchema.nullable(), discovery: discoverySchema, stores: z.array(storeSchema),
  summary: z.object({ storesSelected: z.number(), storefrontMcpVerified: z.number(), storefrontSearchVerified: z.number(), productsReturned: z.number() }),
  limits: z.array(z.string()), receipts: z.array(receiptSchema),
})
export const productResultSchema = z.object({
  domain: z.string(), observedAt: z.string(), product: productSchema,
  selected: z.array(selectionSchema), selectionVerified: z.boolean(), receipts: z.array(receiptSchema),
})

export type MarketOptions = z.infer<typeof marketOptions>
export type SearchOptions = z.infer<typeof searchOptions>
export type Selection = z.infer<typeof selectionSchema>
export type SearchResult = z.infer<typeof searchResultSchema>
export type Product = z.infer<typeof productSchema>
export type Seller = z.infer<typeof sellerSchema>
export type Store = z.infer<typeof storeSchema>
export type Receipt = z.infer<typeof receiptSchema>
export type ErrorInfo = z.infer<typeof errorSchema>
