// The indexer's reads go through the sdk's RPC pool, built as the service builds it, against a
// scripted network. The pool's own rules are the sdk's to test; these pin what the indexer asks of
// it. No test reaches the internet.
import { describe, expect, test } from "bun:test";
import { createRpc } from "../src/main";

type Reply = {
  status?: number;
  result?: unknown;
  error?: { code: number; message: string };
  headers?: Record<string, string>;
};

/** A scripted network: one handler per host, and a log of every request that left. */
function network(handlers: Record<string, () => Reply>) {
  const log: Array<{ host: string; method: string; headers: Headers }> = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const host = new URL(String(url)).host;
    const call = JSON.parse(String(init?.body));
    log.push({
      host,
      method: call.method,
      headers: new Headers(init?.headers),
    });
    const reply = handlers[host]?.() ?? { status: 502 };
    const body = reply.error
      ? { error: reply.error }
      : { result: reply.result ?? null };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: call.id, ...body }),
      { status: reply.status ?? 200, headers: reply.headers },
    );
  }) as typeof fetch;
  return { fetchImpl, log, hosts: () => log.map((l) => l.host) };
}

/** The indexer's pool over the operator's URLs, with a clock the test moves. */
function overridePool(urls: string[], net: ReturnType<typeof network>) {
  let t = 1_000_000;
  const rpc = createRpc(
    { chainId: 84532, rpcUrls: urls },
    {
      fetch: net.fetchImpl,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
  );
  return { rpc, advance: (ms: number) => (t += ms) };
}

const ok = (result: unknown) => () => ({ result });
const rateLimited = (headers?: Record<string, string>) => () => ({
  status: 429,
  error: { code: -32005, message: "rate limit exceeded" },
  headers,
});
const balanceAt = (block: number) => [
  "0x0000000000000000000000000000000000000001",
  `0x${block.toString(16)}`,
];
const LOGS = [
  {
    address: "0x0000000000000000000000000000000000000002",
    fromBlock: "0x1",
    toBlock: "0x2",
  },
];

describe("the free nodes", () => {
  test("should read through the chain's measured free nodes when no override is set", () => {
    const rpc = createRpc({ chainId: 84532 });
    expect([rpc.ordered, rpc.describe().length]).toEqual([false, 5]);
  });
});

describe("the operator's override", () => {
  test("should ask the first URL for every read while it answers", async () => {
    const net = network({ "one.test": ok("0x5"), "two.test": ok("0x5") });
    const { rpc } = overridePool(["https://one.test", "https://two.test"], net);
    for (let block = 1; block <= 4; block += 1) {
      await rpc.request("eth_getBalance", balanceAt(block));
      await rpc.request("eth_blockNumber");
    }
    expect(new Set(net.hosts())).toEqual(new Set(["one.test"]));
  });

  test("should move to the next URL only when the first refuses", async () => {
    const net = network({ "one.test": rateLimited(), "two.test": ok("0x5") });
    const { rpc } = overridePool(["https://one.test", "https://two.test"], net);
    await rpc.request("eth_getBalance", balanceAt(1));
    await rpc.request("eth_getBalance", balanceAt(2));
    expect(net.hosts()).toEqual(["one.test", "two.test", "two.test"]);
  });
});

describe("a polite client", () => {
  test("should send its User-Agent with every request, keeping the content type", async () => {
    const net = network({ "one.test": ok("0x5") });
    const { rpc } = overridePool(["https://one.test"], net);
    await rpc.request("eth_blockNumber");
    const { headers } = net.log[0];
    expect([headers.get("user-agent"), headers.get("content-type")]).toEqual([
      "bermuda-chain-state-indexer",
      "application/json",
    ]);
  });

  test("should send no request to a node inside its Retry-After", async () => {
    const net = network({ "one.test": rateLimited({ "retry-after": "60" }) });
    const { rpc, advance } = overridePool(["https://one.test"], net);
    await rpc.request("eth_blockNumber").catch(() => {});
    advance(30_000);
    const code = await rpc.request("eth_blockNumber").then(
      () => undefined,
      (e: { code?: number }) => e.code,
    );
    expect([code, net.log.length]).toEqual([-32005, 1]);
  });

  test("should ask a node again once its Retry-After has passed", async () => {
    let limited = true;
    const net = network({
      "one.test": () =>
        limited ? rateLimited({ "retry-after": "60" })() : { result: "0x9" },
    });
    const { rpc, advance } = overridePool(["https://one.test"], net);
    await rpc.request("eth_blockNumber").catch(() => {});
    limited = false;
    advance(60_000);
    expect([await rpc.request("eth_blockNumber"), net.log.length]).toEqual([
      "0x9",
      2,
    ]);
  });

  test("should reuse no answer, so a range retried after a mismatch reaches a node", async () => {
    const net = network({ "one.test": ok([]) });
    const { rpc } = overridePool(["https://one.test"], net);
    await rpc.request("eth_getLogs", LOGS);
    await rpc.request("eth_getLogs", LOGS);
    expect(net.log.length).toBe(2);
  });
});
