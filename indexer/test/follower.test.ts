import { afterEach, describe, expect, test } from "bun:test";
import { RpcPool } from "@bermuda/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Follower } from "../src/follower";
import { Store } from "../src/store";
import {
  ADDRESSES,
  FakeChain,
  toBytes32,
  type NodeBehavior,
} from "./fake-chain";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup(
  opts: {
    levels?: number;
    confirmations?: number;
    startBlock?: number;
    node?: NodeBehavior;
    multicall?: boolean;
    chunkBlocks?: number;
    path?: string;
    chain?: FakeChain;
  } = {},
) {
  const chain = opts.chain ?? new FakeChain(opts.levels);
  chain.multicall = opts.multicall ?? true;
  const url = chain.node("a.test", opts.node);
  const rpc = new RpcPool({
    chainId: 31337,
    nodes: [{ url }],
    ordered: true,
    cache: false,
    fetch: ((url, init) => chain.fetch(url, init)) as typeof fetch,
    sleep: async () => {},
  });
  let path = opts.path;
  if (!path) {
    const dir = mkdtempSync(join(tmpdir(), "indexer-follower-"));
    dirs.push(dir);
    path = join(dir, "indexer.sqlite");
  }
  const store = Store.open(path, {
    chainId: "31337",
    pool: ADDRESSES.pool,
    registry: ADDRESSES.registry,
    startBlock: opts.startBlock ?? 1,
  });
  const lines: string[] = [];
  const follower = new Follower({
    store,
    rpc,
    chainId: 31337,
    contracts: { pool: ADDRESSES.pool, registry: ADDRESSES.registry },
    multicall: ADDRESSES.multicall,
    height: opts.levels ?? 23,
    confirmations: opts.confirmations ?? 0,
    intervalSeconds: 60,
    chunkBlocks: opts.chunkBlocks,
    log: (line) => lines.push(line),
  });
  return { chain, rpc, store, follower, lines, path };
}

/** A deployment: the registry's sentinel, two commitments, a nullifier, an account policy. */
function deploy(chain: FakeChain) {
  chain.deployRegistry();
  chain.mine();
  chain.insert([11n, 12n]);
  chain.spend(99n);
  chain.emit(ADDRESSES.safeAccounts, "PolicySealed", [7, 8, "0x0102"]);
  chain.mine();
}

describe("following the chain", () => {
  test("should index every family from the start block and verify it", async () => {
    const { chain, store, follower } = setup();
    deploy(chain);
    chain.writeLeaf(1, 5n);
    chain.emit(ADDRESSES.inboundPolicies, "ReceiveRecordLinked", [0, 5]);
    chain.emit(ADDRESSES.pool, "WithdrawalRequested", [
      1,
      ADDRESSES.keyAccounts,
      ADDRESSES.pool,
      10,
      20,
      false,
    ]);
    chain.emit(ADDRESSES.pool, "VaultAccrued", [ADDRESSES.pool, 1, 2, 3, 4]);
    chain.mine();
    await follower.tick();
    expect([store.meta.confirmed, store.meta.families]).toEqual([
      3,
      {
        commitments: 2,
        nullifiers: 1,
        registry: 3,
        "account-policies": 1,
        withdrawals: 1,
        vaults: 1,
      },
    ]);
  });

  test("should record the roots it matched", async () => {
    const { chain, store, follower } = setup();
    deploy(chain);
    await follower.tick();
    const state = chain.stateAt(2);
    expect(store.meta.roots).toEqual({
      commitments: {
        treeNumber: "0",
        nextIndex: "2",
        root: toBytes32(state.lastRoot),
      },
      registry: { liveRoot: toBytes32(state.liveRoot), nextIndex: "1" },
    });
  });

  test("should stay the confirmation depth behind the tip", async () => {
    const { chain, store, follower } = setup({ confirmations: 3 });
    deploy(chain);
    chain.mine(5);
    await follower.tick();
    expect(store.meta.confirmed).toBe(chain.head - 3);
  });

  test("should query only the new block range on the next tick", async () => {
    const { chain, follower } = setup();
    deploy(chain);
    await follower.tick();
    chain.spend(100n);
    chain.mine(2);
    await follower.tick();
    const last = chain.requests
      .filter((r) => r.method === "eth_getLogs")
      .at(-1)!;
    expect([
      Number(last.params[0].fromBlock),
      Number(last.params[0].toBlock),
    ]).toEqual([3, 5]);
  });

  test("should make no log query when no block is new", async () => {
    const { chain, follower } = setup();
    deploy(chain);
    await follower.tick();
    const before = chain.count("eth_getLogs");
    await follower.tick();
    expect(chain.count("eth_getLogs")).toBe(before);
  });

  test("should cost three requests a tick in the steady state", async () => {
    const { chain, follower } = setup();
    deploy(chain);
    await follower.tick();
    chain.spend(100n);
    chain.mine();
    const before = chain.requests.length;
    await follower.tick();
    expect(chain.requests.slice(before).map((r) => r.method)).toEqual([
      "eth_blockNumber",
      "eth_getLogs",
      "eth_call",
    ]);
  });

  test("should verify with one call per getter when the chain has no multicall", async () => {
    const { chain, store, follower } = setup({ multicall: false });
    deploy(chain);
    await follower.tick();
    expect(store.meta.confirmed).toBe(2);
  });

  test("should check a finished tree's root when the pool rotates", async () => {
    const { chain, store, follower } = setup({ levels: 2 });
    chain.deployRegistry();
    chain.insert([1n, 2n]);
    chain.insert([3n, 4n]);
    chain.mine();
    chain.insert([5n, 6n]);
    chain.mine();
    await follower.tick();
    expect([
      store.meta.confirmed,
      store.meta.roots?.commitments.treeNumber,
    ]).toEqual([2, "1"]);
  });

  test("should split a range into windows the nodes take", async () => {
    const { chain, store, follower } = setup({
      node: { maxLogSpan: 9 },
      chunkBlocks: 1_000,
    });
    deploy(chain);
    chain.mine(400);
    await follower.tick();
    const getLogs = chain.requests.filter((r) => r.method === "eth_getLogs");
    const span = (r: (typeof getLogs)[number]) =>
      Number(r.params[0].toBlock) - Number(r.params[0].fromBlock);
    expect([
      store.meta.confirmed,
      Math.max(...getLogs.filter((r) => r.ok).map(span)),
      getLogs.filter((r) => !r.ok).length,
    ]).toEqual([chain.head, 9, 1]);
  });

  test("should ask for a whole chunk while no node has named a limit", async () => {
    const { chain, store, follower } = setup();
    deploy(chain);
    chain.mine(5_000);
    await follower.tick();
    expect([store.meta.confirmed, chain.count("eth_getLogs")]).toEqual([
      chain.head,
      1,
    ]);
  });
});

describe("verification", () => {
  test("should roll back a range whose roots do not match, and keep confirmed where it was", async () => {
    const { chain, store, follower } = setup();
    deploy(chain);
    await follower.tick();
    chain.insert([13n, 14n]);
    chain.mine();
    chain.behave("a.test", { hideLogsNext: 1 });
    await follower.tick();
    expect([
      store.meta.confirmed,
      store.meta.indexed,
      store.counts(10).commitments,
    ]).toEqual([2, 2, 2]);
  });

  test("should retry a mismatching range on the next tick", async () => {
    const { chain, store, follower } = setup();
    deploy(chain);
    await follower.tick();
    chain.insert([13n, 14n]);
    chain.mine();
    chain.behave("a.test", { hideLogsNext: 1 });
    await follower.tick();
    await follower.tick();
    expect([store.meta.confirmed, store.counts(10).commitments]).toEqual([
      3, 4,
    ]);
  });

  test("should rebuild under a new generation after three mismatching ticks in a row", async () => {
    const { chain, store, follower } = setup();
    deploy(chain);
    await follower.tick();
    const generation = store.meta.generation;
    chain.behave("a.test", { lie: true });
    for (let i = 0; i < 3; i += 1) {
      chain.mine();
      await follower.tick();
    }
    expect([
      store.meta.generation === generation,
      store.meta.confirmed,
      follower.health().reason,
    ]).toEqual([false, 0, "root mismatch"]);
  });

  test("should serve again once the rebuild is verified", async () => {
    const { chain, store, follower } = setup();
    deploy(chain);
    chain.behave("a.test", { lie: true });
    for (let i = 0; i < 3; i += 1) {
      chain.mine();
      await follower.tick();
    }
    chain.behave("a.test", { lie: false });
    await follower.tick();
    expect([store.meta.confirmed, follower.health().ok]).toEqual([
      chain.head,
      true,
    ]);
  });

  test("should wait for a node whose head is below the indexed block, not rebuild", async () => {
    const first = setup();
    deploy(first.chain);
    first.chain.mine(3);
    await first.follower.tick();
    const generation = first.store.meta.generation;
    const confirmed = first.store.meta.confirmed;
    first.store.close();
    // A restart, whose pool has not seen a head yet, reading from a node 13 blocks behind.
    const { chain, store, follower } = setup({
      chain: first.chain,
      path: first.path,
      node: { behind: 13 },
    });
    chain.mine(10);
    for (let i = 0; i < 4; i += 1) await follower.tick();
    const waited = [store.meta.generation === generation, store.meta.confirmed];
    chain.behave("a.test", { behind: 0 });
    await follower.tick();
    expect([...waited, store.meta.confirmed]).toEqual([
      true,
      confirmed,
      chain.head,
    ]);
  });

  test("should absorb a reorg shallower than the confirmation depth", async () => {
    const { chain, store, follower } = setup({ confirmations: 3 });
    deploy(chain);
    chain.mine(3);
    await follower.tick();
    const generation = store.meta.generation;
    chain.insert([21n, 22n]);
    chain.mine();
    chain.reorg(1);
    chain.insert([31n, 32n]);
    chain.mine(4);
    await follower.tick();
    expect([
      store.meta.generation,
      store.meta.confirmed,
      store.counts(100).commitments,
    ]).toEqual([generation, chain.head - 3, 4]);
  });

  test("should rebuild after a reorg deeper than the confirmation depth", async () => {
    const { chain, store, follower } = setup();
    deploy(chain);
    chain.insert([21n, 22n]);
    chain.mine();
    await follower.tick();
    const generation = store.meta.generation;
    chain.reorg(1);
    chain.insert([31n, 32n]);
    chain.mine();
    for (let i = 0; i < 4; i += 1) {
      chain.mine();
      await follower.tick();
    }
    const commitments = store
      .snapshotRows(store.meta.confirmed)
      .map((r) => BigInt(r.commitment));
    expect([store.meta.generation === generation, commitments]).toEqual([
      false,
      [11n, 12n, 31n, 32n],
    ]);
  });

  test("should refuse to serve without the registry's constructor leaf", async () => {
    const { chain, store, follower } = setup({ startBlock: 2 });
    deploy(chain);
    chain.mine();
    await follower.tick();
    expect([
      store.meta.confirmed,
      follower.health().reason,
      chain.count("eth_call") > 1,
    ]).toEqual([1, "start block after registry deployment", false]);
  });

  test("should verify once the registry's constructor leaf arrives after the start block", async () => {
    const { chain, store, follower } = setup();
    chain.mine();
    await follower.tick();
    deploy(chain);
    await follower.tick();
    expect([store.meta.confirmed, follower.health().ok]).toEqual([
      chain.head,
      true,
    ]);
  });
});

describe("contracts and restarts", () => {
  test("should follow the modules the registry wires, read once", async () => {
    const { chain, store, follower } = setup();
    deploy(chain);
    await follower.tick();
    chain.mine();
    await follower.tick();
    const modulesReads = chain.requests.filter(
      (r) => r.method === "eth_call" && r.params[0].to === ADDRESSES.registry,
    ).length;
    expect([store.meta.contracts?.inboundPolicies, modulesReads]).toEqual([
      ADDRESSES.inboundPolicies,
      1,
    ]);
  });

  test("should rebuild when the registry wires its modules after indexing began", async () => {
    const chain = new FakeChain();
    chain.modulesWiredAt = 4;
    const { store, follower } = setup({ chain });
    deploy(chain);
    await follower.tick();
    const generation = store.meta.generation;
    chain.mine();
    chain.mine();
    chain.emit(ADDRESSES.safeAccounts, "PolicySealed", [9, 9, "0x09"]);
    chain.mine();
    await follower.tick();
    await follower.tick();
    expect([
      store.meta.generation === generation,
      store.counts(100)["account-policies"],
    ]).toEqual([false, 2]);
  });

  test("should resume from its database after a restart without rescanning", async () => {
    const first = setup();
    deploy(first.chain);
    await first.follower.tick();
    first.store.close();
    first.chain.insert([13n, 14n]);
    first.chain.mine();
    const again = setup({ chain: first.chain, path: first.path });
    const before = first.chain.requests.length;
    await again.follower.tick();
    const getLogs = first.chain.requests
      .slice(before)
      .filter((r) => r.method === "eth_getLogs");
    expect([
      again.store.meta.confirmed,
      getLogs.map((r) => Number(r.params[0].fromBlock)),
    ]).toEqual([3, [3]]);
  });

  test("should stop between log windows when asked to stop during a long rebuild", async () => {
    const { chain, follower, store } = setup({ node: { maxLogSpan: 9 } });
    deploy(chain);
    chain.mine(400);
    const fetchLogs = chain.fetch;
    let windows = 0;
    (chain as any).fetch = async (url: string, init: RequestInit) => {
      if (
        JSON.parse(String(init.body)).method === "eth_getLogs" &&
        ++windows === 3
      )
        void follower.stop();
      return fetchLogs(url, init);
    };
    follower.start();
    await Bun.sleep(50);
    await follower.stop();
    expect([store.meta.confirmed, store.meta.indexed < chain.head]).toEqual([
      0,
      true,
    ]);
  });

  test("should report itself stale when no tick succeeded for three intervals", async () => {
    const { chain, follower } = setup();
    deploy(chain);
    await follower.tick();
    expect(follower.health(Date.now() + 181_000).reason).toBe("stale");
  });

  test("should name no RPC URL in its log", async () => {
    const { chain, follower, lines } = setup({ node: { rateLimitNext: 50 } });
    deploy(chain);
    await follower.tick();
    expect(lines.join("\n")).not.toContain("a.test");
  });
});
