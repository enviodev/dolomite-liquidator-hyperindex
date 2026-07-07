# Dolomite Liquidator — HyperIndex

A 1:1 [Envio HyperIndex](https://envio.dev) port of the Dolomite liquidator subgraph
(`../dolomite-liquidator-subgraph`). It indexes the Dolomite margin protocol
(margin accounts, per-token balances, market risk params, and async
deposits/withdrawals) across all supported chains in a single multichain indexer,
so it can serve as a drop-in GraphQL endpoint via the subgraph query converter.

## Contracts / chains

Three contracts per chain — `DolomiteMargin`, `Expiry`, `EventEmitterRegistry` —
across Ethereum (1), Arbitrum One (42161), Base (8453), Mantle (5000),
Polygon zkEVM (1101), Berachain (80094), X-Layer (196).
Addresses and start blocks live in `config.yaml`.

## How this differs from the subgraph

- **Lowercase ids.** `address_format: lowercase` matches the subgraph's
  `toHexString()` ids byte-for-byte.
- **`${chainId}-` id prefix.** This is one multichain indexer and several chains
  reuse the same contract/user addresses, so every entity id is namespaced by
  chain to avoid collisions. This is the only deviation from the subgraph's literal
  ids; the query converter scopes per chain.
- **RPC via Effects.** Token metadata (name/symbol/decimals, with bytes32 fallbacks
  and DGD/AAVE overrides) and the initial risk params are read over RPC through the
  Effect API (`src/effects.ts`) — HyperSync cannot read contract state. Set an RPC
  url per chain (`ENVIO_RPC_URL_<chainId>` in `.env`).
- **Array fields.** `borrowTokens` / `supplyTokens` / `expirationTokens` are stored
  as `[String!]!` (arrays of entity ids), because Envio only allows entity arrays
  via `@derivedFrom`. Same values, but they resolve as id strings rather than
  nested objects — note this for the converter. These stay small (bounded by the
  number of distinct tokens an account holds), so an inline array is fine.
  `allUpdateTransactions` is different: it's unbounded (one entry per balance
  update, ever), so it's modelled as a `TokenValueUpdate` join entity exposed via
  `@derivedFrom` instead of an inline array — appending to an inline array here
  would mean reading and copying the full history on every single deposit/
  withdraw/trade/liquidation touching that position, which is O(n²) over the
  life of an actively-traded account and was the cause of an indexer OOM crash.
- **Preserved subgraph quirks** (for exact parity): `LogRemoveMarket` increments
  `numberOfMarkets`; `minBorrowedValue` is divided by 1e18 twice; `LogRemoveMarket`
  deletes `MarketRiskInfo` but not the reverse map.

## Layout

- `config.yaml` — chains, contracts, events (events-only ABIs in `abis/*.events.json`).
- `schema.graphql` — the 10 entities.
- `src/effects.ts` — viem RPC reads.
- `src/handlers/helpers.ts` — BigDecimal helpers, id builders, getOrCreate helpers.
- `src/handlers/{DolomiteMargin,Expiry,EventEmitterRegistry}.ts` — event handlers.
- `src/indexer.test.ts` — handler tests (`createTestIndexer`).

## Develop

```bash
pnpm codegen        # regenerate types after editing config.yaml / schema.graphql
pnpm test           # run handler tests
pnpm dev            # run locally (needs Docker + RPC urls in .env)
```

Visit http://localhost:8080 for the GraphQL playground (local password `testing`).

### Pre-requisites

- [Node.js v22+ (v24 recommended)](https://nodejs.org/en/download/current)
- [pnpm v10+](https://pnpm.io/installation)
- [Docker](https://www.docker.com/products/docker-desktop/) or [Podman](https://podman.io/)
- An RPC endpoint per chain (`ENVIO_RPC_URL_<chainId>`) — see `.env.example`.
