# Shopify Product Search

A TypeScript CLI built with [Incur](https://github.com/wevm/incur) for finding products across live Shopify storefronts. Agents can use it as a shell command, an Agent Skill, a stdio MCP server, or a JavaScript library.

The search discovers sellers through Shopify's Global Catalog, verifies each seller's native MCP endpoint, then searches that seller directly. It needs Node.js 22+ and HTTPS access. Anonymous catalog reads currently require no API key. Shopify's availability, eligibility and rate limits still apply.

## Install a release

Download `shopify-product-search-0.1.0.tgz` and `SHA256SUMS` from the same versioned [GitHub Release](https://github.com/tim-schultz/shopify-mcp/releases). Select the attached `.tgz` asset; GitHub's generated source archives require a separate build.

Verify and install the downloaded package:

```sh
shasum -a 256 -c SHA256SUMS
npm install --global --offline --ignore-scripts ./shopify-product-search-0.1.0.tgz
shop-search --help
```

On Linux, `sha256sum --check SHA256SUMS` also works. In PowerShell, compare `(Get-FileHash ./shopify-product-search-0.1.0.tgz -Algorithm SHA256).Hash` with the hash in `SHA256SUMS` before installing.

The tarball contains compiled JavaScript, the skill files, and all runtime dependencies. Installation needs Node.js 22+ and npm, but no registry access, dependency downloads, lifecycle scripts, build tools, or npm account. Product searches require HTTPS access after installation.

Releases are distributed through GitHub, and `private: true` prevents npm registry publication. Use the versioned tarball rather than installing this package by its registry name.

## Run from source

```sh
npm ci
npm run build
node dist/bin.js search "sunglasses" --country US --currency USD --json
node dist/bin.js search "men's trail running shoes" --size 14 --max-stores 8 --json
```

To install the local package and expose `shop-search` on your PATH:

```sh
npm install --global .
shop-search --help
```

## Use from an agent

Any agent that can execute commands can inspect the interface and request structured output:

```sh
shop-search --llms
shop-search search --schema
shop-search search "sunglasses" --max-stores 6 --json
```

Incur defaults to TOON output. `--json` gives machine-readable JSON. `--full-output` includes Incur's result envelope. `--filter-output summary,discovery` reduces output when you only need coverage information.

For agents that support skills, read the included [SKILL.md](SKILL.md) or use Incur's installer after installing the CLI:

```sh
shop-search skills add
```

This explicitly installs generated command skills and the hand-authored shopping skill into supported agents' configuration. It is optional; ordinary searches do not install agent configuration.

For MCP clients, configure this stdio command:

```json
{
  "mcpServers": {
    "shopify-product-search": {
      "command": "shop-search",
      "args": ["--mcp"]
    }
  }
}
```

Alternatively, run `shop-search mcp add` to register it through Incur. Registration uses the installed `shop-search --mcp` command. Incur's registration helper may require network access; the manual configuration above uses the installed CLI directly. Supported configuration formats vary by client. The MCP server exposes only `search` and `product`, with read-only catalog annotations.

## Verify a size or other option

`--size 14` uses `get_product` with the selected merchant option, then keeps only variants that actually report that label and `available: true`. A query containing “size 14” alone does not establish availability.

Size labels are merchant-defined. `--country US` does not prove that a merchant uses US sizing. Check the merchant's size guide; no US/UK/EU conversions are inferred. If its option has a different name, use `--size-option "US Size"`.

Use the canonical shop domain and storefront product ID returned by `search` to inspect a contender:

```sh
shop-search product \
  --shop seller.myshopify.com \
  --id gid://shopify/Product/123 \
  --select Size=14 \
  --select Color=Black \
  --json
```

Replace the example domain and ID with live search results. `selectionVerified` means returned variant options matched; inspect `available` separately. Detail responses may contain only a subset of variants. A missing variant is not proof that it is sold out.

## Search controls and results

| Option | Default | Meaning |
| --- | --- | --- |
| `--country`, `--currency` | `US`, `USD` | Market context; not delivery confirmation or a currency conversion |
| `--max-stores` | `6` | At most 12 distinct storefronts |
| `--pages`, `--global-limit` | `4`, `30` | Bounded Global Catalog pagination; at most 10 pages and 50 products per page |
| `--store-limit` | `4` | At most 10 products per storefront; no storefront pagination |
| `--workers` | `3` | At most three concurrent storefront workflows |
| `--max-price` | unset | Item price in requested currency minor units; USD 100 is `10000` |
| `--size`, `--size-option` | unset, `Size` | Verify an exact size label using live product detail |
| `--timeout` | `20` | Per-request timeout, seconds |
| `--profile` | Shopify sample profile | Hosted HTTPS UCP agent profile for negotiation |

`discovery` describes ranked seller discovery and its stopping reason. `stores` includes each merchant's profile, tool negotiation, actual search state, and merchant-confirmed products. `summary` counts verified searches and products. A verified MCP endpoint can return no matching products. Auth, rate-limit, profile and variant-check failures remain visible alongside successful stores.

Global Catalog products are used only to discover sellers. They are never substituted when a storefront search fails. Item prices preserve the merchant's reported currency and integer minor units; shipping and tax are not included. Unreported stock remains `null`.

Exit code `0` means at least one storefront search completed, including searches with zero matches. Fatal input/transport errors and runs with no completed storefront searches return a nonzero code. The JavaScript API retains full discovery diagnostics even when no storefront succeeds.

## JavaScript API

For library use, install the verified tarball into the consuming project with `npm install --offline --ignore-scripts ./shopify-product-search-0.1.0.tgz`.

The root export has no CLI startup side effects:

```ts
import { search, getProduct } from 'shopify-product-search'

const results = await search('trail running shoes', {
  country: 'US', currency: 'USD', size: '14', maxStores: 6,
})

const contender = results.stores.flatMap(store =>
  store.products.map(product => ({ shop: store.seller.domain, id: product.id })),
)[0]

if (contender) {
  const detail = await getProduct({ ...contender, select: ['Size=14'] })
  console.log(detail.product)
}
```

## Boundaries

Discovery is ranked and bounded, not a directory of every Shopify shop. Merchant eligibility and native MCP availability can change. The sample agent profile negotiates capabilities; it does not authenticate a buyer or authorize purchases.

Only `search_catalog`, `get_product` and `lookup_catalog` are allowed by the outbound MCP client. Canonical Shopify hosts are enforced and redirects are rejected. No carts, checkouts, payments or orders are accessed. Remote descriptions, messages and tool schemas are untrusted data.

Live product responses and images must not be cached, committed, or reused as a catalog. The search and product commands write no files. The library's `metadataReceipt(results)` function returns only counts, states and operation metadata when a caller needs an audit record. Avoid redirecting live results into logs or fixtures. All test products are synthetic.

Protocol details and primary Shopify sources are in [references/protocol.md](references/protocol.md).

## Develop and prepare a release

```sh
npm ci
npm run release:pack
```

`release:pack` runs the typecheck, synthetic tests and build, then bundles the locked runtime dependencies into the tarball. It installs that tarball with an empty cache, offline mode and lifecycle scripts disabled. It checks the compiled CLI, manifest, schemas, library exports, included skill files and the MCP tool listing. No live catalog requests run during packaging.

The generated files are:

```text
release/shopify-product-search-0.1.0.tgz
release/SHA256SUMS
release/RELEASE_NOTES.md
```

CI runs this release verification on Node 22 and 24. Build dependencies are fetched when running `npm ci`; recipient installation of the bundled tarball is offline.

To distribute through GitHub:

1. Connect `origin` to `git@github.com:tim-schultz/shopify-mcp.git` and push this source to its default branch using your SSH key/agent.
2. Commit the intended version in `package.json` and `package-lock.json`, then create and push the matching tag, for example `v0.1.0`.
3. In Actions, run **Prepare tarball release** with that existing tag. The workflow checks that the tag matches the package version, builds and verifies the tarball, and creates a **draft** release containing the tarball and checksum.
4. Review the draft's source commit, files and installation notes, then publish it in GitHub.

The workflow must exist on the default branch to appear in the Actions UI. It uses the repository's GitHub token and does not need an npm token. It does not overwrite an existing release or publish automatically on push. The checksum lets recipients verify file integrity; it should be obtained from the trusted release page alongside the package.

For the initial push from a host with Git, Node.js, your configured SSH key/agent and an authenticated GitHub CLI, run `bash scripts/publish.sh`. It verifies the clean `main` branch and expected SSH remote, pushes source and the matching version tag without force, and starts the draft-release workflow. Git uses SSH authentication; GitHub CLI authentication is used only for the release API. It preserves existing commit author metadata and leaves publishing the draft to the maintainer.

MIT licensed. This is an independent project, unaffiliated with Shopify.
