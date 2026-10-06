# Chain-state indexer

One small Bun service per deployment. It follows the chain through a polite pool of free RPC
nodes, keeps every event family the sdk reads in `bun:sqlite`, verifies what it stored against the
pool's and the registry's on-chain roots, and serves it over HTTP: the snapshot path released sdks
already fetch, plus incremental pages per family.

- **The database is a cache.** When it is empty, missing, or belongs to another deployment, the
  service rebuilds it from the start block. Nothing is backed up.
- **Clients trust the chain, not the indexer.** Only rows whose roots matched the chain are
  served, and the sdk checks every snapshot against the on-chain roots again before using it.
- **No per-user queries.** Whole families are served; a client never names an account.
- **Its own process, route and lifecycle**, apart from the compliance engine (which holds signing
  keys) and the static file server (which keeps the release's immutable files).

## Running it

```sh
cd indexer
bun install
CHAIN_ID=84532 bun start
```

Against a local chain (testenv), which has no free nodes:

```sh
CHAIN_ID=31337 RPC_URLS=http://localhost:8545 INDEX_CONFIRMATIONS=0 \
  POOL_ADDRESS=0x… ACCOUNT_REGISTRY_ADDRESS=0x… bun start
```

As a container (the database lives on the `/data` volume; the image runs as the non-root `bun`
user, which owns that directory):

```sh
docker build --build-arg GLOBAL_CHECKOUT_TOKEN=… -t chain-state-indexer indexer
docker run -v chain-state:/data -e CHAIN_ID=84532 -p 4200:4200 chain-state-indexer
```

Tests run against an in-process fake chain and never reach the network:

```sh
bun test
bun run typecheck
```

## Configuration

| Variable | Meaning |
|---|---|
| `CHAIN_ID` | The deployment's chain. Required. The sdk preset supplies the addresses, the start block and the tree height. |
| `POOL_ADDRESS`, `ACCOUNT_REGISTRY_ADDRESS`, `MULTICALL_ADDRESS` | Address overrides, named as in the compliance engine. |
| `START_BLOCK` | Overrides the preset's start block. It must not be later than the registry core's deployment block. |
| `INDEX_INTERVAL_SECONDS` | Tick interval. Default `60`. A few minutes is fine: clients catch up the rest over RPC. |
| `INDEX_CONFIRMATIONS` | Blocks to stay behind the tip. Default `12` (about 24 s on Base). Testenv uses `0`. |
| `DB_PATH` | The sqlite file. Default `data/indexer.sqlite`; `/data/indexer.sqlite` in the image. |
| `PORT` | Listen port. Default `4200`. |
| `RPC_URLS`, `RPC_URLS_FILE` | The one RPC override (below). No default. |

### RPC

Every read goes through the sdk's RPC pool (`createRpcPool`), the one every service reads through.
Without `RPC_URLS` or `RPC_URLS_FILE`, it serves the chain's free nodes. It is a polite client, so
the nodes never throttle or ban the service's address:

- one node per request, no fan-out; a request moves to the next node only when a node declines
  (rate limit, down, range too wide, block not there yet), never on a real answer such as a revert;
- reads about now go to one node, reads about the past rotate across the nodes by weight;
- HTTP 429 and `-32005` (and the other quota codes) cool the node with a growing backoff, or for
  as long as its `Retry-After` says, and halve the requests it may have in flight; a rate-limited
  node is asked nothing until then, and when every node is, a read waits up to 2 s for the first,
  else fails at once without a request (the next tick tries again); a node that failed (a network
  error, a 5xx) only goes to the back;
- `eth_getLogs` goes only to nodes that serve logs at that width, and each window is sized to the
  widest node, so no node is asked a range it refuses;
- every request carries a `User-Agent` (some free nodes answer 403 without one).

The service reads the head, one log window and one multicall per tick in the steady state: about
three requests a minute.

`RPC_URLS` (an ordered list, separated by commas, spaces or newlines) or `RPC_URLS_FILE` (the path
of a secret file holding that list, `#` starting a comment) **replaces** the free nodes; the URLs
are then asked in order, with the same refusal handling. A keyed URL may only come from
`RPC_URLS_FILE`; `RPC_URLS` refuses one. No URL is ever logged or returned. The retired names
`RPC`, `RPC_POOL`, `FALLBACK_RPCS`, `BASE_RPC`, `RPC_UPSTREAM` and `RPC_URLS_<CHAIN>` are ignored
with a warning at start, as in every service.

## How it follows the chain

Every tick:

1. Read the head. `target = head - INDEX_CONFIRMATIONS`; nothing to do when `target` is not new.
   A head below the indexed block is a node that lags (after a restart the pool has not yet seen a
   higher head to hold it to), so the tick waits for it rather than count a mismatch.
2. Fetch `[indexed + 1, target]` with one addressed `eth_getLogs` per window: the pool, the
   registry core and its three modules (read once from the core's `modules()`), filtered on the
   sixteen topic0s below. Each window's rows are stored with the indexed watermark in one sqlite
   transaction and applied to the commitment forest and the registry tree, built with the sdk's own
   `LeanMerkleTree` / `RegistryTree` / `poseidon2`.
3. Verify at `target`, pinned, in one multicall (or one call per getter where there is none):
   `getLastRoot()`, `treeNumber()` and `nextIndex()` of the pool must equal the active tree's root,
   number and size; the registry's `liveRoot()` must equal the registry tree's root; each new
   `TreeRotated`'s `finalizedRoot` must equal the finished tree's root.
4. On a match, `confirmed = target`; only rows up to `confirmed` are served. On a mismatch, the
   unverified rows are rolled back and fetched again on the next tick. After three mismatching
   ticks in a row (a reorg deeper than the confirmation depth, or a node serving bad data) the
   database is wiped and rebuilt from the start block under a new **generation**.

The registry core writes `LeafWritten(0, sentinel)` in its constructor, so nothing is verified or
served until that leaf is stored; a start block after the registry's deployment shows as a health
failure. A rebuild after a restart resumes from the stored watermark. If the registry wires its
modules only after indexing began, the database is rebuilt so the modules' earlier logs are read.

## HTTP contract

Everything is served under `/chain-state/`, the path the sdk appends to `config.chainState`.
Behind the edge router the rule is `PathPrefix(/bermuda/{version}/chain-state)` with only
`/bermuda/{version}` stripped. One process serves one chain and one pool; any other `{chainId}` or
`{pool}` is `404`. `{chainId}` is decimal, `{pool}` is matched case-insensitively.

| Route | Purpose |
|---|---|
| `GET /chain-state/refs/heads/main/{chainId}/{pool}/commitment-events.json` | the compatibility snapshot |
| `GET /chain-state/v1/{chainId}/{pool}/head` | what is indexed and verified |
| `GET /chain-state/v1/{chainId}/{pool}/events?family=…&from=…[&to=…][&limit=…]` | incremental pages |
| `GET /chain-state/health` | liveness, for the container healthcheck and the alerter |

Common rules:

- Methods `GET`, `HEAD` and `OPTIONS` (CORS preflight); anything else is `405`.
- `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: If-None-Match`,
  `Access-Control-Expose-Headers: ETag`.
- `Content-Encoding: gzip` when the request accepts it, always with `Vary: Accept-Encoding`.
- A strong `ETag` and `Cache-Control: no-cache` on every answer: clients always revalidate, and a
  matching `If-None-Match` costs a `304` without a body.
- `Content-Type: application/json; charset=utf-8`. Errors are `{ "error": "<message>" }`: `400` a
  missing or malformed parameter or an unknown family, `404` an unknown path, chain or pool, `405` a
  method, `503` not ready.
- Values in rows: `uintN` / `intN` as decimal strings, `bytes` / `bytesN` as lowercase `0x` hex
  (`"0x"` when empty), `address` as lowercase hex, `bool` as a JSON boolean. Positions (`block`,
  `tx`, `log`) and block numbers in responses are JSON numbers. Query parameters are decimal.

### Compatibility snapshot

The body released sdks parse: `block` is `String(confirmed)` and `events` holds every
`CommitmentInserted` up to `confirmed`, ordered by `(treeNumber, leafIndex)`, as
`{ commitment, index, encryptedOutput, treeNumber }`. `ETag: "{generation}:{confirmed}"`. It is
`503 { "error": "indexing" }` until the first verified tick; old sdks then use their local cache
and RPC.

### Head

```json
{
  "chainId": "84532",
  "generation": "9f2c41d07ab3e6c5",
  "startBlock": 47293435,
  "head": 47720790,
  "confirmed": 47720778,
  "confirmations": 12,
  "intervalSeconds": 60,
  "verifiedAt": 1791216000,
  "contracts": { "pool": "0x…", "registry": "0x…", "inboundPolicies": "0x…", "safeAccounts": "0x…", "keyAccounts": "0x…" },
  "roots": {
    "commitments": { "treeNumber": "0", "nextIndex": "1784", "root": "0x…" },
    "registry": { "liveRoot": "0x…", "nextIndex": "412" }
  },
  "families": { "commitments": 1786, "nullifiers": 903, "registry": 1220, "account-policies": 37, "withdrawals": 12, "vaults": 210 }
}
```

`confirmed` is the highest block whose rows are stored and whose roots matched the chain;
`startBlock - 1` before the first verification (with `roots` and `verifiedAt` null). `head` is the
tip at that verification. `generation` changes whenever the database is rebuilt; a client drops
the rows it took under another generation. `roots` are the on-chain values at `confirmed`, for a
client's local pre-check only. `families` are row counts. `ETag: "{generation}:{confirmed}"`.

### Events

`family` is one of the families below. `from` (inclusive) is required. `to` (inclusive) defaults
to `confirmed` and is clamped to it. `limit` is a soft maximum of rows per page, default `1000`,
at most `5000`: a page always ends on a block boundary, and a first block with more rows than
`limit` is still returned whole.

```json
{
  "family": "commitments",
  "generation": "9f2c41d07ab3e6c5",
  "from": 47293435,
  "to": 47301877,
  "next": 47301878,
  "confirmed": 47720778,
  "events": [
    {
      "block": 47293502, "tx": 3, "log": 11, "txHash": "0x…", "address": "0x…",
      "event": "CommitmentInserted",
      "treeNumber": "0", "commitment": "0x…", "leafIndex": "0", "encryptedOutput": "0x…"
    }
  ]
}
```

`events` holds every row of the family in blocks `[from, to]`, ordered by `(block, log)`. `to` is
the last block the page covers: the last row's block when the limit cut it short, else the
requested bound. `next` is `to + 1` while `to` is below the bound, else `null`. `from` above
`confirmed` is an empty page with `to: from - 1`. `tx` is the transaction index and `log` the log
index in the block. `ETag: "{generation}:{family}:{from}:{to}"`: a covered range never changes
within a generation.

### Health

`200 { "ok": true, "chainId", "head", "confirmed", "verifiedAt", "generation" }` while the last
successful tick is less than `3 × INDEX_INTERVAL_SECONDS` old. Otherwise `503` with `"ok": false`
and a `reason`: `"indexing"` (the first build is not verified yet), `"stale"` (no successful tick
in the window), `"root mismatch"` (three ticks failed verification and the database is being
rebuilt) or `"start block after registry deployment"` (no `LeafWritten` at index 0 since the start
block).

### Families

Every row carries `block`, `tx`, `log`, `txHash`, `address` (the emitter) and `event`, then the
event's fields in declaration order, named as in the ABI.

| Family | Emitter | Events |
|---|---|---|
| `commitments` | pool | `CommitmentInserted(uint32 treeNumber, bytes32 commitment, uint256 leafIndex, bytes encryptedOutput)`, `TreeRotated(uint32 indexed newTreeNumber, bytes32 finalizedRoot)` |
| `nullifiers` | pool | `NullifierSpent(bytes32 nullifier)` |
| `registry` | registry core, inbound module | `LeafWritten(uint256 indexed index, uint256 leaf)`, `ReceiveRecordLinked(uint256 indexed owner, uint256 next)`, `ReceiveRecordBound(uint256 indexed owner, uint256 indexed accountId, address writer, uint64 index)`, `InboundRulesSet(uint256 indexed owner, uint64 rules)`, `SenderRootSet(uint256 indexed owner, uint256 senderRoot)`, `InboundWriterSet(uint256 indexed owner, address writer)` |
| `account-policies` | SafeAccounts, KeyAccounts | `PolicySealed(uint256 indexed accountId, uint256 root, bytes sealedList)` |
| `withdrawals` | pool | `WithdrawalRequested(uint256 indexed requestId, address indexed recipient, address indexed token, uint256 amount, uint64 claimableAt, bool unwrap)`, `WithdrawalClaimed(uint256 indexed requestId, address indexed recipient, address token, uint256 amount)` |
| `vaults` | pool | `VaultAccrued(address indexed token, uint256 assets, uint256 shares, uint256 index, uint256 feeSharesMinted)`, `VaultClassUpdated(address indexed token, uint256 shares, uint256 buffer, uint256 venueShares)`, `AutovaultConverted(address indexed token, uint256 idleIn, uint256 sharesOut)`, `FeesSwept(address indexed token, address indexed to, uint256 shares, uint256 assets)` |

The registry is one family because rebuilding it needs both contracts' logs in one chain order;
every row carries `tx` so a client can stop at a transaction boundary.

## Storage

One table `events(block, log, tx, family, event, tree_number, position, value, row)` keyed by
`(block, log)`, with an index on `(family, block, log)`; `row` is the served JSON, and
`tree_number` / `position` / `value` hold the tree inputs of commitments, rotations and registry
leaves, so rebuilding the trees reads no ciphertext. One table `meta` holds the generation, the
start block, the indexed and confirmed watermarks, the verification time, the contracts, the roots
at `confirmed` and the row counts.
