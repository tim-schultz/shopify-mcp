# Shopify catalog protocol

This implementation targets Shopify's current `2026-08-25` catalog contract. Inspect the live negotiated schema if a provider reports `schema_changed`.

## Discovery and negotiation

- Global discovery: `https://catalog.shopify.com/api/ucp/mcp`.
- Canonical merchant catalog: `https://<seller>.myshopify.com/api/ucp/mcp`.
- Business profile: `https://<seller>.myshopify.com/.well-known/ucp`.
- Default negotiation profile: `https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json`.

Every `tools/list` uses `params.arguments.meta.ucp-agent.profile`; every `tools/call` uses `params.arguments.meta.ucp-agent.profile`. Tool calls also carry `params.arguments.catalog`. Only `search_catalog`, `get_product` and `lookup_catalog` are allowed outbound; the CLI currently exposes search and product detail workflows.

The public sample profile establishes negotiation, not buyer authentication or payment authority. Supply a hosted HTTPS profile with `--profile` when using your own agent identity. Some merchants may require authentication; this package does not bypass that requirement.

Business profiles are read for evidence. The code independently negotiates the known native MCP endpoint even if profile discovery fails. Arbitrary advertised endpoints are never followed. Only canonical Shopify hosts/paths are allowed; HTTP redirects are rejected.

## Requests

Search arguments inside `catalog`:

```json
{
  "query": "trail running shoes",
  "context": { "address_country": "US", "currency": "USD" },
  "filters": { "available": true },
  "pagination": { "limit": 30 }
}
```

Read sellers from `products[].variants[].seller`, deduplicating both seller ID and canonical domain. Product-level Global Catalog URLs are not merchant discovery evidence. Global products are never returned as storefront products.

Follow opaque `pagination.cursor` values while `has_next_page` is true, preserving query/context/filters. Stop at the requested seller/page budget, repeated cursor, no next page, or an error. Shopify documents at most 50 results per page and a 1,000-result pagination depth; the CLI additionally caps discovery at 10 pages. Ranked search is not a complete merchant inventory. Storefront search fetches only the requested first page, at most 10 products.

Product arguments inside `catalog`:

```json
{
  "id": "gid://shopify/Product/123",
  "selected": [{ "name": "Size", "label": "14" }],
  "context": { "address_country": "US", "currency": "USD" }
}
```

The product ID must match the requested merchant product. Global UPIDs (`gid://shopify/p/...`) are not accepted. `get_product` can return only selected/default variants; it is not an exhaustive variant listing. Returned option labels and stock are checked independently of the requested selection, so a provider fallback does not become a verified size match.

## Transport and failures

JSON-RPC responses support JSON and SSE, validate response IDs, cap body size at 4 MB, and use per-request timeouts. SSE stops after the matching reply instead of waiting indefinitely for a stream to close. HTTP 401/403 is `authentication_required`, 404 is `endpoint_not_found`, and 429 is `rate_limited` with `retryAt`. No automatic retry occurs; an in-process cooldown prevents repeated calls to the same endpoint/operation until its deadline. JSON-RPC rate-limit errors receive a conservative 60-second cooldown.

A failed profile does not establish an absent MCP server. Successful tool negotiation does not establish a matching product. Successful catalog queries can return no matches. Partial store failures remain in results when other storefronts work. If no storefront search completes, the CLI exits nonzero; the library returns the diagnostic result.

Prices retain integer minor units and reported currencies. Unknown exponents are explicitly displayed as minor units. Price caps are checked only within the requested currency; no conversion is inferred. Availability is `true`, `false`, or `null` when unreported. General search shows up to five variants per product; detail returns the variants supplied by the merchant, which may be a subset.

Product payloads and images are not persisted. The library's `metadataReceipt` function returns timestamps, endpoints, operations, status, counts and errors; no query, product IDs, descriptions or prices. Search/product commands write no files. Tests use synthetic fixtures only.

## Primary sources

- [Global Catalog MCP](https://shopify.dev/docs/agents/catalog/global-catalog)
- [Storefront Catalog MCP](https://shopify.dev/docs/agents/catalog/storefront-catalog)
- [Agent profiles](https://shopify.dev/docs/agents/profiles)
- [Authentication and rate limits](https://shopify.dev/docs/agents/profiles/auth-and-rate-limiting)
- [Catalog usage guidelines](https://shopify.dev/docs/agents/catalog)
- [Incur](https://github.com/wevm/incur)
