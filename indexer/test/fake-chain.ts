// An in-process chain for the follower and server tests. It holds blocks of real ABI-encoded
// logs, emulates the pool's batched commitment inserts (rotation included) and the registry's
// leaves, and answers JSON-RPC from that state: `eth_getLogs`, pinned `eth_call` (the pool's and
// the registry's getters, `modules()` and the multicall) and `eth_blockNumber`. Every host it
// serves is a node with its own quirks, and every request is recorded.
import { RegistryTree } from "@bermuda/sdk";
import { LeanMerkleTree, poseidon2 } from "@bermuda/sdk/internal";
import { Interface, zeroPadValue, toBeHex } from "ethers";
import { EVENTS } from "../src/families";

export const ADDRESSES = {
  pool: "0x00000000000000000000000000000000000000aa",
  registry: "0x00000000000000000000000000000000000000bb",
  inboundPolicies: "0x00000000000000000000000000000000000000cc",
  safeAccounts: "0x00000000000000000000000000000000000000dd",
  keyAccounts: "0x00000000000000000000000000000000000000ee",
  multicall: "0x00000000000000000000000000000000000000ff",
};
const ZERO = "0x0000000000000000000000000000000000000000";

const events = new Interface(EVENTS.map((e) => e.fragment.format("full")));
const calls = new Interface([
  "function getLastRoot() view returns (bytes32)",
  "function treeNumber() view returns (uint32)",
  "function nextIndex() view returns (uint256)",
  "function liveRoot() view returns (uint256)",
  "function modules() view returns (address safeAccounts, address keyAccounts, address inboundPolicies)",
  "function multicall((address to, bytes data, uint256 value)[] calls) payable returns (bytes[] returnData)",
]);

export interface NodeBehavior {
  /** `addressed`: refuses address-less log filters, as publicnode does. */
  logs?: "any" | "addressed";
  /** Refuses wider log windows, worded as sepolia.base.org words it. */
  maxLogSpan?: number;
  /** Its head lags the chain by this many blocks. */
  behind?: number;
  /** The next this-many requests answer HTTP 429 / -32005. */
  rateLimitNext?: number;
  /** The next this-many `eth_getLogs` answers silently drop their last log. */
  hideLogsNext?: number;
  /** Answers `getLastRoot()` with a wrong root. */
  lie?: boolean;
}

interface Log {
  address: string;
  topics: string[];
  data: string;
  block: number;
  tx: number;
  log: number;
}

type Tx = Array<{ address: string; topics: string[]; data: string }>;

export class FakeChain {
  head = 0;
  modulesWiredAt = 0;
  multicall = true;
  readonly requests: Array<{
    node: string;
    method: string;
    params: any[];
    ok?: boolean;
  }> = [];
  private readonly blocks = new Map<number, Log[]>();
  private pending: Tx[] = [];
  private readonly nodes = new Map<string, NodeBehavior>();

  constructor(readonly levels = 23) {}

  /** A node of this chain; its URL is what a pool member points at. */
  node(host: string, behavior: NodeBehavior = {}): string {
    this.nodes.set(host, behavior);
    return `http://${host}`;
  }

  behave(host: string, patch: NodeBehavior): void {
    this.nodes.set(host, { ...this.nodes.get(host), ...patch });
  }

  // ── transactions, each mined into the next block ────────────────────────────

  emit(address: string, event: string, values: unknown[]): void {
    this.pending.push([this.encode(address, event, values)]);
  }

  /** The registry's constructor leaf. */
  deployRegistry(sentinel = 1n): void {
    this.emit(ADDRESSES.registry, "LeafWritten", [0, sentinel]);
  }

  writeLeaf(index: number, leaf: bigint): void {
    this.emit(ADDRESSES.registry, "LeafWritten", [index, leaf]);
  }

  /** One pool transaction inserting a batch, rotating first when it does not fit. */
  insert(commitments: bigint[], ciphertext = "0xabcd"): void {
    const state = this.replay(this.allLogs(), true);
    let treeNumber = state.treeNumber;
    let start = state.nextIndex;
    const tx: Tx = [];
    if (start + commitments.length > 2 ** this.levels) {
      tx.push(
        this.encode(ADDRESSES.pool, "TreeRotated", [
          treeNumber + 1,
          toBytes32(state.lastRoot),
        ]),
      );
      treeNumber += 1;
      start = 0;
    }
    commitments.forEach((c, i) =>
      tx.push(
        this.encode(ADDRESSES.pool, "CommitmentInserted", [
          treeNumber,
          toBytes32(c),
          start + i,
          i === commitments.length - 1 && commitments.length % 2 === 0
            ? "0x"
            : ciphertext,
        ]),
      ),
    );
    this.pending.push(tx);
  }

  spend(nullifier: bigint): void {
    this.emit(ADDRESSES.pool, "NullifierSpent", [toBytes32(nullifier)]);
  }

  /** Put the pending transactions into the next block, then mine `empty` empty blocks more. */
  mine(empty = 0): number {
    const block = this.head + 1;
    const logs: Log[] = [];
    this.pending.forEach((tx, txIndex) =>
      tx.forEach((l) =>
        logs.push({ ...l, block, tx: txIndex, log: logs.length }),
      ),
    );
    this.blocks.set(block, logs);
    this.pending = [];
    this.head = block + empty;
    return block;
  }

  /** Drop the last `depth` blocks; the next `mine` builds the new branch. */
  reorg(depth: number): void {
    for (let b = this.head - depth + 1; b <= this.head; b += 1)
      this.blocks.delete(b);
    this.head -= depth;
  }

  // ── state ───────────────────────────────────────────────────────────────────

  stateAt(block: number) {
    return this.replay(
      this.allLogs().filter((l) => l.block <= block),
      false,
    );
  }

  private allLogs(): Log[] {
    const logs = [...this.blocks.values()].flat();
    this.pending.forEach((tx) =>
      tx.forEach((l) => logs.push({ ...l, block: Infinity, tx: 0, log: 0 })),
    );
    return logs;
  }

  private replay(logs: Log[], _live: boolean) {
    const trees = new Map<number, bigint[]>();
    let treeNumber = 0;
    let lastTree = 0;
    const registry = new RegistryTree();
    let registryNext = 0n;
    for (const l of logs) {
      const parsed = events.parseLog({ topics: l.topics, data: l.data })!;
      if (parsed.name === "CommitmentInserted") {
        const tn = Number(parsed.args.treeNumber);
        const leaves = trees.get(tn) ?? [];
        leaves[Number(parsed.args.leafIndex)] = BigInt(parsed.args.commitment);
        trees.set(tn, leaves);
        lastTree = tn;
      } else if (parsed.name === "TreeRotated") {
        treeNumber = Number(parsed.args.newTreeNumber);
        lastTree = treeNumber;
      } else if (parsed.name === "LeafWritten") {
        registry.set(BigInt(parsed.args.index), BigInt(parsed.args.leaf));
        if (BigInt(parsed.args.index) + 1n > registryNext)
          registryNext = BigInt(parsed.args.index) + 1n;
      }
    }
    treeNumber = Math.max(treeNumber, lastTree);
    const active = trees.get(treeNumber) ?? [];
    const dense = Array.from(active, (v) => v ?? 0n);
    const lastRoot =
      dense.length === 0
        ? 0n
        : BigInt(
            new LeanMerkleTree(this.levels, dense, { hashFunction: poseidon2 })
              .root,
          );
    return {
      treeNumber,
      nextIndex: dense.length,
      lastRoot,
      liveRoot: registry.root,
      registryNext,
    };
  }

  private encode(address: string, event: string, values: unknown[]) {
    const { data, topics } = events.encodeEventLog(event, values);
    return { address, topics, data };
  }

  // ── JSON-RPC ────────────────────────────────────────────────────────────────

  readonly fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    const behavior = this.nodes.get(host);
    const call = JSON.parse(String(init?.body));
    const record: (typeof this.requests)[number] = {
      node: host,
      method: call.method,
      params: call.params,
    };
    this.requests.push(record);
    const reply = (body: object, status = 200) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...body }), {
        status,
      });
    if (!behavior) return new Response("no such node", { status: 502 });
    if (behavior.rateLimitNext) {
      behavior.rateLimitNext -= 1;
      return reply(
        { error: { code: -32005, message: "rate limit exceeded" } },
        429,
      );
    }
    try {
      const result = this.answer(call.method, call.params ?? [], behavior);
      record.ok = true;
      return reply({ result });
    } catch (e) {
      const error = e as { code?: number; message: string };
      return reply({
        error: { code: error.code ?? -32000, message: error.message },
      });
    }
  }) as typeof fetch;

  private answer(method: string, params: any[], node: NodeBehavior): unknown {
    const nodeHead = this.head - (node.behind ?? 0);
    const blockOf = (tag: unknown) => {
      if (tag === undefined || tag === "latest") return nodeHead;
      const n = Number(BigInt(tag as string));
      if (n > nodeHead) throw rpcError(-32001, `header not found`);
      return n;
    };
    switch (method) {
      case "eth_chainId":
        return "0x7a69";
      case "eth_blockNumber":
        return toBeHex(nodeHead);
      case "eth_getLogs": {
        const f = params[0];
        const from = Number(BigInt(f.fromBlock));
        const to =
          f.toBlock === "latest" ? nodeHead : Number(BigInt(f.toBlock));
        if (to > nodeHead)
          throw rpcError(
            -32602,
            `block range extends beyond current head block: requested ${to}`,
          );
        if (node.maxLogSpan !== undefined && to - from > node.maxLogSpan)
          throw rpcError(
            -32614,
            `eth_getLogs is limited to a ${node.maxLogSpan.toLocaleString("en-US")} range`,
          );
        if (node.logs === "addressed" && !f.address)
          throw rpcError(-32701, "Please specify an address in your request");
        const addresses = f.address
          ? [f.address].flat().map((a: string) => a.toLowerCase())
          : null;
        const topics0 = f.topics?.[0] ? [f.topics[0]].flat() : null;
        const logs: object[] = [];
        for (let b = from; b <= to; b += 1) {
          for (const l of this.blocks.get(b) ?? []) {
            if (addresses && !addresses.includes(l.address.toLowerCase()))
              continue;
            if (topics0 && !topics0.includes(l.topics[0])) continue;
            logs.push({
              address: l.address,
              topics: l.topics,
              data: l.data,
              blockNumber: toBeHex(l.block),
              transactionIndex: toBeHex(l.tx),
              logIndex: toBeHex(l.log),
              transactionHash: zeroPadValue(
                toBeHex(l.block * 1000 + l.tx + 1),
                32,
              ),
              removed: false,
            });
          }
        }
        if (node.hideLogsNext && logs.length > 0) {
          node.hideLogsNext -= 1;
          logs.pop();
        }
        return logs;
      }
      case "eth_call": {
        const block = blockOf(params[1]);
        return this.call(params[0].to, params[0].data, block, node);
      }
      default:
        throw rpcError(-32601, `method not found`);
    }
  }

  private call(
    to: string,
    data: string,
    block: number,
    node: NodeBehavior,
  ): string {
    const target = to.toLowerCase();
    const parsed = calls.parseTransaction({ data });
    if (!parsed) throw rpcError(3, "execution reverted");
    if (target === ADDRESSES.multicall) {
      if (!this.multicall) return "0x";
      const results = parsed.args.calls.map((c: any) =>
        this.call(c.to, c.data, block, node),
      );
      return calls.encodeFunctionResult("multicall", [results]);
    }
    const state = this.stateAt(block);
    const result = (name: string, values: unknown[]) =>
      calls.encodeFunctionResult(name, values);
    if (target === ADDRESSES.pool) {
      if (parsed.name === "getLastRoot")
        return result("getLastRoot", [
          toBytes32(node.lie ? state.lastRoot + 1n : state.lastRoot),
        ]);
      if (parsed.name === "treeNumber")
        return result("treeNumber", [state.treeNumber]);
      if (parsed.name === "nextIndex")
        return result("nextIndex", [state.nextIndex]);
    }
    if (target === ADDRESSES.registry) {
      if (parsed.name === "liveRoot")
        return result("liveRoot", [state.liveRoot]);
      if (parsed.name === "nextIndex")
        return result("nextIndex", [state.registryNext]);
      if (parsed.name === "modules") {
        const wired = block >= this.modulesWiredAt;
        return result(
          "modules",
          wired
            ? [
                ADDRESSES.safeAccounts,
                ADDRESSES.keyAccounts,
                ADDRESSES.inboundPolicies,
              ]
            : [ZERO, ZERO, ZERO],
        );
      }
    }
    if (
      [
        ADDRESSES.inboundPolicies,
        ADDRESSES.safeAccounts,
        ADDRESSES.keyAccounts,
      ].includes(target)
    ) {
      throw rpcError(3, "execution reverted");
    }
    return "0x";
  }

  /** How many requests of a method reached the chain. */
  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }
}

function rpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

export function toBytes32(value: bigint): string {
  return zeroPadValue(toBeHex(value), 32);
}
