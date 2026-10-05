import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Row } from "../src/families";
import { Store, type Identity } from "../src/store";

const identity: Identity = {
  chainId: "31337",
  pool: "0x00000000000000000000000000000000000000aa",
  registry: "0x00000000000000000000000000000000000000bb",
  startBlock: 10,
};

const dirs: string[] = [];
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "indexer-store-"));
  dirs.push(dir);
  return join(dir, "indexer.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

let logCounter = 0;
function nullifier(block: number, log = logCounter++): Row {
  return {
    block,
    tx: 0,
    log,
    txHash: `0x${"11".repeat(32)}`,
    address: identity.pool,
    family: "nullifiers",
    event: "NullifierSpent",
    fields: { nullifier: `0x${block.toString(16).padStart(64, "0")}` },
  };
}
function commitment(
  block: number,
  log: number,
  treeNumber: number,
  leafIndex: number,
): Row {
  return {
    block,
    tx: 0,
    log,
    txHash: `0x${"22".repeat(32)}`,
    address: identity.pool,
    family: "commitments",
    event: "CommitmentInserted",
    fields: {
      treeNumber: String(treeNumber),
      commitment: `0x${(leafIndex + 1).toString(16).padStart(64, "0")}`,
      leafIndex: String(leafIndex),
      encryptedOutput: leafIndex % 2 ? "0x" : "0xabcd",
    },
  };
}
function leafWritten(
  block: number,
  log: number,
  index: number,
  leaf: bigint,
): Row {
  return {
    block,
    tx: 0,
    log,
    txHash: `0x${"33".repeat(32)}`,
    address: identity.registry,
    family: "registry",
    event: "LeafWritten",
    fields: { index: String(index), leaf: leaf.toString() },
  };
}

describe("a fresh store", () => {
  test("should start below the start block with a new generation", () => {
    const store = Store.open(dbPath(), identity);
    expect(store.meta.indexed).toBe(9);
    expect(store.meta.confirmed).toBe(9);
    expect(store.meta.generation).toMatch(/^[0-9a-f]{16}$/);
  });

  test("should keep its generation and rows when reopened for the same deployment", () => {
    const path = dbPath();
    const first = Store.open(path, identity);
    first.append([nullifier(11)], 11);
    const generation = first.meta.generation;
    first.close();
    const again = Store.open(path, identity);
    expect([again.meta.generation, again.meta.indexed]).toEqual([
      generation,
      11,
    ]);
  });

  test("should rebuild from scratch when reopened for another deployment", () => {
    const path = dbPath();
    const first = Store.open(path, identity);
    first.append([nullifier(11)], 11);
    const generation = first.meta.generation;
    first.close();
    const other = Store.open(path, {
      ...identity,
      pool: "0x00000000000000000000000000000000000000ff",
    });
    expect(other.meta.generation).not.toBe(generation);
    expect(other.meta.indexed).toBe(9);
  });
});

describe("a database written by another version", () => {
  test("should be rebuilt when its schema differs", () => {
    const path = dbPath();
    const first = Store.open(path, identity);
    first.append([nullifier(11)], 11);
    const generation = first.meta.generation;
    first.close();
    const db = new Database(path);
    const stored = JSON.parse(
      db
        .query<
          { value: string },
          []
        >("SELECT value FROM meta WHERE key = 'identity'")
        .get()!.value,
    );
    db.query("UPDATE meta SET value = ? WHERE key = 'identity'").run(
      JSON.stringify({ ...stored, schema: stored.schema + 1 }),
    );
    db.close();
    expect([
      typeof stored.schema,
      Store.open(path, identity).meta.generation === generation,
    ]).toEqual(["number", false]);
  });
});

describe("append, rollback and wipe", () => {
  test("should move the indexed watermark with the rows", () => {
    const store = Store.open(dbPath(), identity);
    store.append([nullifier(12), nullifier(15)], 20);
    expect(store.meta.indexed).toBe(20);
  });

  test("should drop every row above the block it rolls back to", () => {
    const store = Store.open(dbPath(), identity);
    store.append([nullifier(12), nullifier(15)], 20);
    store.rollback(12);
    expect(store.counts(100).nullifiers).toBe(1);
  });

  test("should start a new generation on a wipe", () => {
    const store = Store.open(dbPath(), identity);
    store.append([nullifier(12)], 20);
    store.confirm({
      confirmed: 20,
      head: 25,
      verifiedAt: 1,
      roots: null,
      contracts: { ...identity },
    });
    const generation = store.meta.generation;
    store.wipe();
    expect([
      store.meta.generation === generation,
      store.meta.confirmed,
      store.counts(100).nullifiers,
    ]).toEqual([false, 9, 0]);
  });

  test("should count each family up to a block", () => {
    const store = Store.open(dbPath(), identity);
    store.append([nullifier(12), commitment(13, 0, 0, 0), nullifier(14)], 20);
    expect(store.counts(13)).toEqual({
      commitments: 1,
      nullifiers: 1,
      registry: 0,
      "account-policies": 0,
      withdrawals: 0,
      vaults: 0,
    });
  });
});

describe("tree inputs", () => {
  test("should list commitments in chain order with their tree and index", () => {
    const store = Store.open(dbPath(), identity);
    store.append(
      [
        commitment(12, 1, 0, 1),
        commitment(12, 0, 0, 0),
        commitment(13, 0, 1, 0),
      ],
      20,
    );
    expect(
      store.commitmentLeaves(20).map((c) => [c.treeNumber, c.leafIndex]),
    ).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
  });

  test("should know whether the registry's sentinel leaf was written", () => {
    const store = Store.open(dbPath(), identity);
    store.append([leafWritten(12, 0, 1, 5n)], 20);
    expect(store.hasSentinel()).toBe(false);
    store.append([leafWritten(21, 0, 0, 7n)], 30);
    expect(store.hasSentinel()).toBe(true);
  });

  test("should give the compatibility rows ordered by tree and index", () => {
    const store = Store.open(dbPath(), identity);
    store.append(
      [
        commitment(13, 0, 1, 0),
        commitment(12, 0, 0, 0),
        commitment(12, 1, 0, 1),
      ],
      20,
    );
    expect(store.snapshotRows(20).map((r) => [r.treeNumber, r.index])).toEqual([
      ["0", "0"],
      ["0", "1"],
      ["1", "0"],
    ]);
  });
});

describe("pages", () => {
  function storeWith(blocks: number[]) {
    const store = Store.open(dbPath(), identity);
    store.append(
      blocks.map((b, i) => nullifier(b, i)),
      100,
    );
    return store;
  }

  test("should return every row in the range, in chain order, and end at the bound", () => {
    const store = storeWith([11, 12, 12, 15]);
    const page = store.page("nullifiers", 11, 20, 1000);
    expect([page.rows.length, page.to, page.next]).toEqual([4, 20, null]);
  });

  test("should end a page cut by the limit on the last row's block", () => {
    const store = storeWith([11, 12, 13, 14]);
    const page = store.page("nullifiers", 11, 20, 2);
    expect([page.rows.length, page.to, page.next]).toEqual([2, 12, 13]);
  });

  test("should never split a block across pages", () => {
    const store = storeWith([11, 12, 12, 13]);
    const page = store.page("nullifiers", 11, 20, 2);
    expect([page.rows.length, page.to, page.next]).toEqual([1, 11, 12]);
  });

  test("should return a whole first block even when it holds more rows than the limit", () => {
    const store = storeWith([12, 12, 12, 13]);
    const page = store.page("nullifiers", 11, 20, 2);
    expect([page.rows.length, page.to, page.next]).toEqual([3, 12, 13]);
  });

  test("should serve each row with its positions first", () => {
    const store = storeWith([11]);
    expect(
      Object.keys(JSON.parse(store.page("nullifiers", 11, 11, 10).rows[0])),
    ).toEqual([
      "block",
      "tx",
      "log",
      "txHash",
      "address",
      "event",
      "nullifier",
    ]);
  });
});
