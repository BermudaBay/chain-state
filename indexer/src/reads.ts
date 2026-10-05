import { Interface } from "ethers";
import { TOPICS, type RpcLog } from "./families";

/**
 * The JSON-RPC surface the indexer needs: the pool's `request`, built without a read cache so a
 * retry after a mismatch asks the chain again. `widestLogSpan`, when offered, lets the follower
 * size its log windows so no node refuses them.
 */
export interface Rpc {
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  widestLogSpan?(filter?: { address?: unknown }): number;
}

const abi = new Interface([
  "function getLastRoot() view returns (bytes32)",
  "function treeNumber() view returns (uint32)",
  "function nextIndex() view returns (uint256)",
  "function liveRoot() view returns (uint256)",
  "function modules() view returns (address safeAccounts, address keyAccounts, address inboundPolicies)",
  "function multicall((address to, bytes data, uint256 value)[] calls) payable returns (bytes[] returnData)",
]);

const hex = (n: number) => `0x${n.toString(16)}`;

/** The chain tip, through the pool's primary node. */
export async function readHead(rpc: Rpc): Promise<number> {
  return Number(BigInt(await rpc.request<string>("eth_blockNumber")));
}

/**
 * Every log of the families' events from `addresses` in blocks `[from, to]`, in chain order: one
 * addressed `eth_getLogs` with all topic0s.
 */
export async function readLogs(
  rpc: Rpc,
  addresses: readonly string[],
  from: number,
  to: number,
): Promise<RpcLog[]> {
  const logs = await rpc.request<RpcLog[]>("eth_getLogs", [
    {
      address: addresses,
      topics: [TOPICS],
      fromBlock: hex(from),
      toBlock: hex(to),
    },
  ]);
  if (!Array.isArray(logs))
    throw new Error("eth_getLogs answered without a list");
  const seen = new Set<string>();
  return logs
    .filter((log) => {
      const block = Number(BigInt(log.blockNumber));
      if (block < from || block > to) {
        throw new Error(
          `a node answered a log at block ${block} for blocks ${from}..${to}`,
        );
      }
      const key = `${block}:${Number(BigInt(log.logIndex))}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
        Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
    );
}

/** The registry's modules, or `null` while it has not wired them. */
export async function readModules(
  rpc: Rpc,
  registry: string,
): Promise<{
  safeAccounts: string;
  keyAccounts: string;
  inboundPolicies: string;
} | null> {
  const raw = await rpc.request<string>("eth_call", [
    { to: registry, data: abi.encodeFunctionData("modules") },
    "latest",
  ]);
  if (raw === "0x") throw new Error(`no contract at the registry ${registry}`);
  const [safeAccounts, keyAccounts, inboundPolicies] = abi
    .decodeFunctionResult("modules", raw)
    .map((a: string) => a.toLowerCase());
  const wired = [safeAccounts, keyAccounts, inboundPolicies].every(
    (a) => !/^0x0{40}$/.test(a),
  );
  return wired ? { safeAccounts, keyAccounts, inboundPolicies } : null;
}

/** The pool's and the registry's values the indexer checks its trees against. */
export interface ChainRoots {
  lastRoot: bigint;
  treeNumber: number;
  nextIndex: number;
  liveRoot: bigint;
  registryNextIndex: bigint;
}

/**
 * The roots at `block`, pinned: one multicall where the chain has one, else one call per getter.
 * A multicall that is missing or reverts falls back to the single calls.
 */
export async function readRoots(
  rpc: Rpc,
  contracts: { pool: string; registry: string; multicall?: string },
  block: number,
): Promise<ChainRoots> {
  const getters: Array<[string, string]> = [
    [contracts.pool, "getLastRoot"],
    [contracts.pool, "treeNumber"],
    [contracts.pool, "nextIndex"],
    [contracts.registry, "liveRoot"],
    [contracts.registry, "nextIndex"],
  ];
  const tag = hex(block);
  let results: string[] | null = null;
  if (contracts.multicall) {
    try {
      const calls = getters.map(([to, name]) => ({
        to,
        data: abi.encodeFunctionData(name),
        value: 0,
      }));
      const raw = await rpc.request<string>("eth_call", [
        {
          to: contracts.multicall,
          data: abi.encodeFunctionData("multicall", [calls]),
        },
        tag,
      ]);
      results = [...abi.decodeFunctionResult("multicall", raw)[0]];
    } catch (error) {
      if (!isRevertOrBadData(error)) throw error;
    }
  }
  if (!results) {
    results = [];
    for (const [to, name] of getters) {
      const raw = await rpc.request<string>("eth_call", [
        { to, data: abi.encodeFunctionData(name) },
        tag,
      ]);
      if (raw === "0x")
        throw new Error(`no contract at ${to} at block ${block}`);
      results.push(raw);
    }
  }
  const value = (i: number) =>
    BigInt(abi.decodeFunctionResult(getters[i][1], results![i])[0]);
  return {
    lastRoot: value(0),
    treeNumber: Number(value(1)),
    nextIndex: Number(value(2)),
    liveRoot: value(3),
    registryNextIndex: value(4),
  };
}

/** A revert, or an answer that does not decode (`0x` from an address without code). */
function isRevertOrBadData(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  return (
    e?.code === 3 ||
    e?.code === "BAD_DATA" ||
    /revert/i.test(String(e?.message ?? ""))
  );
}
