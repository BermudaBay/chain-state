import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIndexer, withUserAgent } from "../src/main";
import { ADDRESSES, FakeChain } from "./fake-chain";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The fake chain behind a real HTTP endpoint. */
function serve(chain: FakeChain): string {
  chain.node("a.test");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) =>
      chain.fetch("http://a.test", {
        method: "POST",
        body: await request.text(),
      }),
  });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

async function until(
  read: () => Promise<any>,
  done: (value: any) => boolean,
): Promise<any> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(50);
  }
}

describe("withUserAgent", () => {
  test("should send the User-Agent with every request, keeping the other headers", async () => {
    let seen: Headers | undefined;
    const base = (async (_: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response("{}");
    }) as unknown as typeof fetch;
    await withUserAgent(base, "indexer-test")("http://node.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect([seen?.get("user-agent"), seen?.get("content-type")]).toEqual([
      "indexer-test",
      "application/json",
    ]);
  });
});

describe("the service", () => {
  test("should follow a chain over HTTP and serve what it verified", async () => {
    const chain = new FakeChain();
    chain.deployRegistry();
    chain.mine();
    chain.insert([11n, 12n]);
    chain.mine();
    const rpc = serve(chain);
    const dir = mkdtempSync(join(tmpdir(), "indexer-main-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const lines: string[] = [];
    const indexer = await startIndexer(
      {
        CHAIN_ID: "31337",
        RPC_URLS: rpc,
        POOL_ADDRESS: ADDRESSES.pool,
        ACCOUNT_REGISTRY_ADDRESS: ADDRESSES.registry,
        MULTICALL_ADDRESS: ADDRESSES.multicall,
        START_BLOCK: "1",
        INDEX_CONFIRMATIONS: "0",
        INDEX_INTERVAL_SECONDS: "1",
        DB_PATH: join(dir, "db", "indexer.sqlite"),
        PORT: "0",
      },
      (line) => lines.push(line),
    );
    cleanups.push(() => indexer.stop());

    const health = await until(
      async () => (await fetch(`${indexer.url}/chain-state/health`)).json(),
      (h: any) => h.ok,
    );
    chain.insert([13n, 14n]);
    chain.mine();
    const page = await until(
      async () =>
        (
          await fetch(
            `${indexer.url}/chain-state/v1/31337/${ADDRESSES.pool}/events?family=commitments&from=3`,
          )
        ).json(),
      (p: any) => p.events.length > 0,
    );
    expect([
      health.ok,
      page.events.map((e: any) => e.leafIndex),
      lines.join("\n").includes(rpc),
    ]).toEqual([true, ["2", "3"], false]);
  });
});
