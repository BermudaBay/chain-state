/**
 * The free RPC nodes each chain's reads go through by default, as data for the pool. A copy of
 * the sdk's `rpc-nodes.ts` table, which owns the measurements; it goes when the sdk release that
 * exports it is pinned here. No entry carries a key: a keyed endpoint only ever comes from the
 * operator's `RPC_URLS_FILE`, and then replaces this table.
 *
 * The nodes are not interchangeable, so each entry records what it was measured to serve. The
 * numbers are hints, not rules: the pool learns every refusal at run time, because the limits
 * move. Base Sepolia, measured 2026-10-05 from Node:
 *
 *   | node                             | address-less logs | addressed logs | block 0 |
 *   |----------------------------------|-------------------|----------------|---------|
 *   | base-sepolia.gateway.tenderly.co | 10k ok            | 200k ok        | yes     |
 *   | base-sepolia-rpc.publicnode.com  | refused           | <= 50,000      | pruned  |
 *   | base-sepolia.rpc.sentio.xyz      | 10k ok            | <= 100,000     | yes     |
 *   | base-testnet.api.pocket.network  | 1k ok             | <= 5,000       | yes     |
 *   | sepolia.base.org                 | <= 500            | <= 500         | pruned  |
 *
 * Left out: base-sepolia.drpc.org, which answers a log window past its own head with an empty
 * list, a silent hole in a history scan.
 */

/** What a free node is expected to serve: hints the pool starts from and corrects at run time. */
export interface RpcNode {
  url: string;
  /** `any`: log filters with or without an `address`; `addressed`: only with one; `none`: no logs. */
  logs?: "any" | "addressed" | "none";
  /** The widest `toBlock - fromBlock` it accepts; absent when no limit was observed. */
  maxLogSpan?: number;
  /** Its share of the traffic, and of the draw for the node that answers reads about now. */
  weight?: number;
}

export interface RpcChain {
  nodes: readonly RpcNode[];
}

const chain = (nodes: RpcNode[]): RpcChain =>
  Object.freeze({ nodes: Object.freeze(nodes.map((n) => Object.freeze(n))) });

/** Every chain with measured free nodes, by chain id. */
export const RPC_CHAINS: Readonly<Record<number, RpcChain>> = Object.freeze({
  84532: chain([
    { url: "https://base-sepolia.gateway.tenderly.co", logs: "any", weight: 3 },
    {
      url: "https://base-sepolia-rpc.publicnode.com",
      logs: "addressed",
      maxLogSpan: 50_000,
      weight: 3,
    },
    {
      url: "https://base-sepolia.rpc.sentio.xyz",
      logs: "any",
      maxLogSpan: 100_000,
      weight: 2,
    },
    {
      url: "https://base-testnet.api.pocket.network",
      logs: "any",
      maxLogSpan: 5_000,
      weight: 2,
    },
    {
      url: "https://sepolia.base.org",
      logs: "any",
      maxLogSpan: 500,
      weight: 2,
    },
  ]),
  1: chain([
    {
      url: "https://ethereum-rpc.publicnode.com",
      logs: "addressed",
      weight: 2,
    },
    { url: "https://mainnet.gateway.tenderly.co", logs: "any", weight: 2 },
  ]),
  // One public endpoint each, probed 2026-09-21.
  100: chain([{ url: "https://rpc.gnosischain.com" }]),
  9746: chain([{ url: "https://testnet-rpc.plasma.to" }]),
  59141: chain([{ url: "https://rpc.sepolia.linea.build" }]),
  46630: chain([{ url: "https://rpc.testnet.chain.robinhood.com/rpc" }]),
  5042002: chain([{ url: "https://rpc.testnet.arc.network" }]),
});

/** The measured free nodes of `chainId`, or undefined for a chain without any. */
export function rpcChainOf(chainId: number | bigint): RpcChain | undefined {
  return RPC_CHAINS[Number(chainId)];
}
