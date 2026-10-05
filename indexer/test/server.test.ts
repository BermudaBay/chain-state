import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Row } from "../src/families";
import type { Health } from "../src/follower";
import { createApp } from "../src/server";
import { Store } from "../src/store";

const POOL = "0x00000000000000000000000000000000000000aa";
const REGISTRY = "0x00000000000000000000000000000000000000bb";
const BASE = `http://indexer.test/chain-state`;
const COMPAT = `${BASE}/refs/heads/main/31337/${POOL}/commitment-events.json`;
const V1 = `${BASE}/v1/31337/${POOL}`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function commitment(block: number, log: number, leafIndex: number): Row {
  return {
    block,
    tx: 0,
    log,
    txHash: `0x${"22".repeat(32)}`,
    address: POOL,
    family: "commitments",
    event: "CommitmentInserted",
    fields: {
      treeNumber: "0",
      commitment: `0x${(leafIndex + 1).toString(16).padStart(64, "0")}`,
      leafIndex: String(leafIndex),
      encryptedOutput: "0xabcd",
    },
  };
}

function setup(opts: { verified?: boolean; health?: Partial<Health> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "indexer-server-"));
  dirs.push(dir);
  const store = Store.open(join(dir, "indexer.sqlite"), {
    chainId: "31337",
    pool: POOL,
    registry: REGISTRY,
    startBlock: 10,
  });
  store.append(
    [
      commitment(11, 0, 0),
      commitment(11, 1, 1),
      commitment(12, 0, 2),
      commitment(14, 0, 3),
    ],
    15,
  );
  const contracts = { pool: POOL, registry: REGISTRY };
  if (opts.verified ?? true) {
    store.confirm({
      confirmed: 13,
      head: 25,
      verifiedAt: 1_791_216_000,
      contracts,
      roots: {
        commitments: {
          treeNumber: "0",
          nextIndex: "3",
          root: `0x${"01".repeat(32)}`,
        },
        registry: { liveRoot: `0x${"02".repeat(32)}`, nextIndex: "1" },
      },
    });
  }
  const health: Health = {
    ok: true,
    chainId: "31337",
    head: 25,
    confirmed: store.meta.confirmed,
    verifiedAt: store.meta.verifiedAt,
    generation: store.meta.generation,
    ...opts.health,
  };
  const app = createApp({
    store,
    follower: { health: () => health, following: contracts },
    chainId: 31337,
    pool: POOL,
    confirmations: 12,
    intervalSeconds: 60,
  });
  const get = (
    url: string,
    headers: Record<string, string> = {},
    method = "GET",
  ) => app.fetch(new Request(url, { method, headers }));
  return { store, app, get };
}

describe("the compatibility snapshot", () => {
  test("should serve the crawler's shape up to the confirmed block, with tree numbers", async () => {
    const { get } = setup();
    expect((await (await get(COMPAT)).json()) as any).toEqual({
      block: "13",
      events: [0, 1, 2].map((i) => ({
        commitment: `0x${(i + 1).toString(16).padStart(64, "0")}`,
        index: String(i),
        encryptedOutput: "0xabcd",
        treeNumber: "0",
      })),
    });
  });

  test("should answer 503 until the first verified tick", async () => {
    const { get } = setup({ verified: false });
    const res = await get(COMPAT);
    expect([res.status, (await res.json()) as any]).toEqual([
      503,
      { error: "indexing" },
    ]);
  });

  test("should tag it with the generation and the confirmed block", async () => {
    const { get, store } = setup();
    expect((await get(COMPAT)).headers.get("etag")).toBe(
      `"${store.meta.generation}:13"`,
    );
  });

  test("should answer a matching revalidation with 304 and no body", async () => {
    const { get, store } = setup();
    const res = await get(COMPAT, {
      "if-none-match": `"${store.meta.generation}:13"`,
    });
    expect([res.status, await res.text()]).toEqual([304, ""]);
  });

  test("should gzip it for a client that accepts gzip", async () => {
    const { get } = setup();
    const res = await get(COMPAT, { "accept-encoding": "gzip, deflate" });
    const body = JSON.parse(
      gunzipSync(Buffer.from(await res.arrayBuffer())).toString(),
    );
    expect([
      res.headers.get("content-encoding"),
      res.headers.get("vary"),
      body.block,
    ]).toEqual(["gzip", "Accept-Encoding", "13"]);
  });

  test("should match the pool address case-insensitively", async () => {
    const { get } = setup();
    expect(
      (await get(COMPAT.replace(POOL, POOL.toUpperCase().replace("0X", "0x"))))
        .status,
    ).toBe(200);
  });

  test("should answer 404 for another chain or pool", async () => {
    const { get } = setup();
    expect([
      (await get(COMPAT.replace("/31337/", "/1/"))).status,
      (await get(COMPAT.replace(POOL, REGISTRY))).status,
    ]).toEqual([404, 404]);
  });
});

describe("the head", () => {
  test("should describe what is indexed and verified", async () => {
    const { get, store } = setup();
    expect((await (await get(`${V1}/head`)).json()) as any).toEqual({
      chainId: "31337",
      generation: store.meta.generation,
      startBlock: 10,
      head: 25,
      confirmed: 13,
      confirmations: 12,
      intervalSeconds: 60,
      verifiedAt: 1_791_216_000,
      contracts: {
        pool: POOL,
        registry: REGISTRY,
        inboundPolicies: null,
        safeAccounts: null,
        keyAccounts: null,
      },
      roots: {
        commitments: {
          treeNumber: "0",
          nextIndex: "3",
          root: `0x${"01".repeat(32)}`,
        },
        registry: { liveRoot: `0x${"02".repeat(32)}`, nextIndex: "1" },
      },
      families: {
        commitments: 3,
        nullifiers: 0,
        registry: 0,
        "account-policies": 0,
        withdrawals: 0,
        vaults: 0,
      },
    });
  });

  test("should report the block below the start block before the first verification", async () => {
    const { get } = setup({ verified: false });
    const head = (await (await get(`${V1}/head`)).json()) as any;
    expect([head.confirmed, head.roots, head.verifiedAt]).toEqual([
      9,
      null,
      null,
    ]);
  });
});

describe("events", () => {
  test("should serve a family's rows up to the confirmed block, never the unverified ones", async () => {
    const { get } = setup();
    const page = (await (
      await get(`${V1}/events?family=commitments&from=10`)
    ).json()) as any;
    expect([
      page.from,
      page.to,
      page.next,
      page.confirmed,
      page.events.map((e: any) => e.leafIndex),
    ]).toEqual([10, 13, null, 13, ["0", "1", "2"]]);
  });

  test("should serve each row with its positions, emitter and event", async () => {
    const { get } = setup();
    const page = (await (
      await get(`${V1}/events?family=commitments&from=12&to=12`)
    ).json()) as any;
    expect(page.events).toEqual([
      {
        block: 12,
        tx: 0,
        log: 0,
        txHash: `0x${"22".repeat(32)}`,
        address: POOL,
        event: "CommitmentInserted",
        treeNumber: "0",
        commitment: `0x${"3".padStart(64, "0")}`,
        leafIndex: "2",
        encryptedOutput: "0xabcd",
      },
    ]);
  });

  test("should page by blocks and point at the next one", async () => {
    const { get } = setup();
    const page = (await (
      await get(`${V1}/events?family=commitments&from=10&limit=1`)
    ).json()) as any;
    expect([page.to, page.next, page.events.length]).toEqual([11, 12, 2]);
  });

  test("should answer a range above the confirmed block with an empty page", async () => {
    const { get } = setup();
    const page = (await (
      await get(`${V1}/events?family=commitments&from=14`)
    ).json()) as any;
    expect([page.events, page.to, page.next]).toEqual([[], 13, null]);
  });

  test("should tag a page with the generation, family and covered range", async () => {
    const { get, store } = setup();
    const res = await get(`${V1}/events?family=commitments&from=10&to=11`);
    expect(res.headers.get("etag")).toBe(
      `"${store.meta.generation}:commitments:10:11"`,
    );
  });

  test("should answer 304 to a page's revalidation", async () => {
    const { get, store } = setup();
    const res = await get(`${V1}/events?family=commitments&from=10&to=11`, {
      "if-none-match": `W/"x", "${store.meta.generation}:commitments:10:11"`,
    });
    expect(res.status).toBe(304);
  });

  test("should refuse an unknown family, a missing from and a malformed bound with 400", async () => {
    const { get } = setup();
    const statuses = await Promise.all(
      [
        `${V1}/events?family=notes&from=1`,
        `${V1}/events?family=commitments`,
        `${V1}/events?family=commitments&from=0x10`,
        `${V1}/events?family=commitments&from=12&to=11`,
        `${V1}/events?family=commitments&from=1&limit=0`,
      ].map(async (url) => (await get(url)).status),
    );
    expect(statuses).toEqual([400, 400, 400, 400, 400]);
  });

  test("should explain a 400 in a JSON error", async () => {
    const { get } = setup();
    expect(
      (await (await get(`${V1}/events?family=notes&from=1`)).json()) as any,
    ).toEqual({ error: "unknown family notes" });
  });
});

describe("health and the common rules", () => {
  test("should answer 200 while healthy", async () => {
    const { get } = setup();
    const res = await get(`${BASE}/health`);
    expect([res.status, ((await res.json()) as any).ok]).toEqual([200, true]);
  });

  test("should answer 503 with the reason while unhealthy", async () => {
    const { get } = setup({ health: { ok: false, reason: "indexing" } });
    const res = await get(`${BASE}/health`);
    expect([res.status, ((await res.json()) as any).reason]).toEqual([
      503,
      "indexing",
    ]);
  });

  test("should allow any origin and expose the ETag", async () => {
    const { get } = setup();
    const res = await get(`${V1}/head`);
    expect([
      res.headers.get("access-control-allow-origin"),
      res.headers.get("access-control-expose-headers"),
      res.headers.get("cache-control"),
      res.headers.get("content-type"),
    ]).toEqual(["*", "ETag", "no-cache", "application/json; charset=utf-8"]);
  });

  test("should answer a preflight with the allowed methods and headers", async () => {
    const { get } = setup();
    const res = await get(`${V1}/head`, {}, "OPTIONS");
    expect([
      res.status,
      res.headers.get("access-control-allow-headers"),
    ]).toEqual([204, "If-None-Match"]);
  });

  test("should answer HEAD with the headers and no body", async () => {
    const { get } = setup();
    const res = await get(COMPAT, {}, "HEAD");
    expect([
      res.status,
      res.headers.get("etag") !== null,
      await res.text(),
    ]).toEqual([200, true, ""]);
  });

  test("should refuse other methods with 405", async () => {
    const { get } = setup();
    expect((await get(`${V1}/head`, {}, "POST")).status).toBe(405);
  });

  test("should answer 404 for an unknown path", async () => {
    const { get } = setup();
    expect((await get(`${BASE}/v2/whatever`)).status).toBe(404);
  });
});
