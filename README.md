# Chain State

The chain data the sdk bootstraps from, so it need not scan every log over RPC.

## Indexer

[`indexer/`](indexer/README.md) is the service each deployment runs: it follows the chain through
a polite pool of free RPC nodes, verifies every event family the sdk reads against the on-chain
roots, and serves them over HTTP, including the snapshot path below.

## Crawler

`main.js` periodically downloads the most recent chain state via
[GitHub Actions](https://github.com/features/actions) and commits it to this repository, for the
deployments that predate the indexer.

1. `git clone <url>`
2. `npm install`
3. `bun run main.js`
