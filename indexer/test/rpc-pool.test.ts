// The polite client, driven against a scripted network: each member is a host whose replies are
// worded as the free nodes worded them when they were measured. No test reaches the internet.
import { describe, expect, test } from "bun:test";
import {
  BLOCK_UNAVAILABLE,
  BLOCK_WAIT_MS,
  RpcError,
  RpcPool,
  classify,
  createRpcPool,
  type RpcNode,
  type Verdict,
} from "../src/rpc-pool";

type Call = { id: unknown; method: string; params: any[] };
type Reply = {
  status?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
  raw?: string;
  throws?: boolean;
  headers?: Record<string, string>;
};
type Handler = (call: Call) => Reply;

/** A scripted network: one handler per host, and a log of every request that left. */
function network(handlers: Record<string, Handler>) {
  const log: Array<{
    host: string;
    method: string;
    params: any[];
    init: RequestInit;
  }> = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const host = new URL(String(url)).host;
    const call = JSON.parse(String(init?.body)) as Call;
    log.push({
      host,
      method: call.method,
      params: call.params,
      init: init ?? {},
    });
    const reply = (
      handlers[host] ?? (() => ({ status: 500, raw: "no handler" }))
    )(call);
    if (reply.throws)
      throw new TypeError(`Unable to connect to ${String(url)}`);
    const text =
      reply.raw ??
      JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        ...(reply.error
          ? { error: reply.error }
          : { result: reply.result ?? null }),
      });
    return new Response(text, {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  }) as typeof fetch;
  return { fetchImpl, log, hosts: () => log.map((l) => l.host) };
}

/** A pool with a pinned clock, a recorded sleep and a pinned draw. */
function pool(
  nodes: RpcNode[],
  net: ReturnType<typeof network>,
  opts: Partial<{
    ordered: boolean;
    localChainId: boolean;
    cache: boolean;
  }> = {},
) {
  let t = 1_000_000;
  const slept: number[] = [];
  const p = new RpcPool({
    chainId: 84532,
    nodes,
    fetch: net.fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    random: () => 0,
    ...opts,
  });
  return { p, slept, advance: (ms: number) => (t += ms) };
}

const m = (host: string, spec: Partial<RpcNode> = {}): RpcNode => ({
  url: `https://${host}`,
  ...spec,
});
const rpc = (method: string, params: unknown[] = [], id: unknown = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const ok =
  (result: unknown): Handler =>
  () => ({ result });
const hex = (n: number) => `0x${n.toString(16)}`;
const rateLimited: Handler = () => ({
  status: 429,
  error: { code: -32005, message: "rate limit exceeded" },
});
/** A rate limit that names how long to stay away. */
const retryAfter60: Handler = () => ({
  status: 429,
  error: { code: -32005, message: "rate limit exceeded" },
  headers: { "retry-after": "60" },
});
const balanceAt = (i: number, block: string) =>
  rpc("eth_getBalance", [`0x${String(i).padStart(40, "0")}`, block], i);

describe("classify", () => {
  const cases: Array<[string, number, unknown, string]> = [
    [
      "tenderly burst",
      429,
      { error: { code: -32005, message: "rate limit exceeded" } },
      "rate-limited",
    ],
    [
      "sepolia.base.org 25/s",
      429,
      {
        error: {
          code: -32007,
          message: "25/second request limit reached - reduce calls per second",
        },
      },
      "rate-limited",
    ],
    [
      "alchemy request limit",
      200,
      { error: { code: -32011, message: "request limit reached" } },
      "rate-limited",
    ],
    [
      "drpc range",
      400,
      {
        error: {
          code: 35,
          message: "ranges over 10000 blocks are not supported on free plan",
        },
      },
      "range",
    ],
    [
      "sepolia.base.org range",
      413,
      {
        error: {
          code: -32614,
          message: "eth_getLogs is limited to a 1,000 range",
        },
      },
      "range",
    ],
    [
      "publicnode range",
      200,
      { error: { code: -32701, message: "exceed maximum block range: 50000" } },
      "range",
    ],
    [
      "nodies range",
      200,
      {
        error: {
          code: -32001,
          message:
            "Block range too large: maximum allowed is 50 blocks on your current plan",
        },
      },
      "range",
    ],
    [
      "publicnode address-less",
      200,
      {
        error: {
          code: -32701,
          message:
            "Please specify an address in your request or, to remove restrictions, order a dedicated full node",
        },
      },
      "needs-address",
    ],
    [
      "tenderly future block",
      200,
      { error: { code: -32001, message: "block not found: 0x2d4aa2c" } },
      "not-yet",
    ],
    [
      "drpc future block",
      400,
      { error: { code: 26, message: "Unknown block" } },
      "not-yet",
    ],
    [
      "past-head window",
      200,
      {
        error: {
          code: -32602,
          message:
            "block range extends beyond current head block: requested 47493001",
        },
      },
      "not-yet",
    ],
    [
      "sentio past head",
      200,
      {
        error: {
          code: -32000,
          message:
            "block 47492950 is beyond the latest block 47492941 of this node, retry later",
        },
      },
      "not-yet",
    ],
    [
      "pocket range",
      200,
      {
        error: {
          code: -32602,
          message: "query exceeds max block range 100000",
        },
      },
      "range",
    ],
    [
      "pocket address-less",
      500,
      {
        error: {
          code: -31001,
          message:
            "internal error: no archival-capable endpoints available for archival requests",
        },
      },
      "declined",
    ],
    [
      "pocket request size",
      200,
      {
        error: {
          code: -32602,
          message: "request is too complex/large, try lesser input",
        },
      },
      "range",
    ],
    [
      "drpc genesis",
      200,
      {
        error: {
          code: 4444,
          message:
            "pruned history unavailable: requested 0, earliest available 46000000",
        },
      },
      "pruned",
    ],
    [
      "pruned state",
      200,
      {
        error: { code: -32603, message: "state at block #45491598 is pruned" },
      },
      "pruned",
    ],
    [
      "zan unregistered",
      429,
      {
        error: {
          code: -32012,
          message:
            'cu limit exceeded; Method "eth_getLogs" is not available for unregistered users',
        },
      },
      "unsupported",
    ],
    [
      "blast shut down",
      403,
      {
        error: {
          code: -32000,
          message:
            "Blast API is no longer available. Please update your integration",
        },
      },
      "down",
    ],
    ["cloudflare 521", 521, undefined, "down"],
    ["network error", 0, undefined, "down"],
    [
      "a revert",
      200,
      { error: { code: 3, message: "execution reverted", data: "0x08c379a0" } },
      "answer",
    ],
    [
      "an invalid-params answer",
      400,
      {
        error: {
          code: -32602,
          message: "invalid argument 0: hex string without 0x prefix",
        },
      },
      "answer",
    ],
    ["a result", 200, { result: "0x1" }, "answer"],
    ["a null result", 200, { result: null }, "answer"],
  ];
  for (const [what, status, body, kind] of cases) {
    test(`should read ${what} as ${kind}`, () => {
      expect(classify(status, body).kind).toBe(kind as Verdict["kind"]);
    });
  }

  test("should read the width a range refusal names", () => {
    expect(
      classify(413, {
        error: {
          code: -32614,
          message: "eth_getLogs is limited to a 1,000 range",
        },
      }),
    ).toEqual({ kind: "range", cap: 1000 });
    expect(
      classify(200, {
        error: { code: -32701, message: "exceed maximum block range: 50000" },
      }),
    ).toEqual({ kind: "range", cap: 50000 });
    expect(
      classify(200, {
        error: {
          code: -32602,
          message: "query exceeds max block range 100000",
        },
      }),
    ).toEqual({ kind: "range", cap: 100000 });
  });

  test("should match every wording of a block a node has not reached, and not a revert", () => {
    for (const message of [
      "block not found: 0x2d20a84",
      "Unknown block",
      "header not found",
      "missing trie node 0x1",
    ]) {
      expect(BLOCK_UNAVAILABLE.test(message)).toBe(true);
    }
    expect(BLOCK_UNAVAILABLE.test("execution reverted")).toBe(false);
    expect([...BLOCK_WAIT_MS]).toEqual([400, 900, 1800]);
  });
});

describe("one node for NOW, every node for THEN", () => {
  const members = [m("a.test"), m("b.test"), m("c.test")];
  const everyone = (fn: Handler) => ({
    "a.test": fn,
    "b.test": fn,
    "c.test": fn,
  });

  test("should send every read about NOW to one primary", async () => {
    const net = network(everyone(ok("0x10")));
    const { p } = pool(members, net);
    for (let i = 0; i < 6; i += 1) {
      await p.serve(rpc("eth_blockNumber", [], i), { fresh: true });
      await p.serve(
        rpc(
          "eth_call",
          [
            {
              to: "0x0000000000000000000000000000000000000001",
              data: `0x0${i}`,
            },
            "latest",
          ],
          i,
        ),
      );
    }
    expect(new Set(net.hosts()).size).toBe(1);
  });

  test("should spread reads about THEN across the members", async () => {
    const net = network(everyone(ok("0x0")));
    const { p } = pool(members, net);
    for (let i = 0; i < 9; i += 1) {
      await p.serve(
        rpc(
          "eth_getBalance",
          [`0x${String(i + 1).padStart(40, "0")}`, hex(1000 + i)],
          i,
        ),
      );
    }
    expect([...new Set(net.hosts())].sort()).toEqual([
      "a.test",
      "b.test",
      "c.test",
    ]);
  });

  test("should give a member of weight 3 three turns for every one of weight 1", async () => {
    const net = network({ "a.test": ok("0x0"), "b.test": ok("0x0") });
    const { p } = pool(
      [m("a.test", { weight: 3 }), m("b.test", { weight: 1 })],
      net,
    );
    for (let i = 0; i < 8; i += 1)
      await p.serve(
        rpc(
          "eth_getBalance",
          [`0x${String(i + 1).padStart(40, "0")}`, hex(50 + i)],
          i,
        ),
      );
    expect(net.hosts().filter((h) => h === "a.test").length).toBe(6);
  });

  test("should never let eth_blockNumber run backwards across a failover", async () => {
    let aHead = 100;
    const net = network({
      "a.test": () =>
        aHead === -1 ? { status: 503, raw: "down" } : { result: hex(aHead) },
      "b.test": ok(hex(98)),
    });
    const { p } = pool([m("a.test"), m("b.test")], net);
    expect(await p.request<string>("eth_blockNumber")).toBe(hex(100));
    aHead = -1;
    expect(
      ((await p.serve(rpc("eth_blockNumber"), { fresh: true })) as any).result,
    ).toBe(hex(100));
  });
});

describe("a refusal moves on, an answer does not", () => {
  test("should halve a rate-limited node's concurrency and regrow it by one per ten answers", async () => {
    let limited = true;
    const net = network({
      "a.test": (c) => (limited ? rateLimited(c) : { result: "0x1" }),
      "b.test": ok("0x1"),
    });
    const { p, advance } = pool([m("a.test", { weight: 5 }), m("b.test")], net);
    await p.serve(
      rpc("eth_getBalance", [
        "0x0000000000000000000000000000000000000013",
        "0x10",
      ]),
    );
    expect(p.describe()[0].limit).toBe(3);
    limited = false;
    for (let i = 0; i < 12; i += 1) {
      advance(60_000);
      await p.serve(
        rpc(
          "eth_getBalance",
          [`0x${String(100 + i).padStart(40, "0")}`, hex(0x20 + i)],
          i,
        ),
      );
    }
    expect(p.describe()[0].limit).toBe(4);
  });

  test("should wait out one cooldown when nobody is left to ask, and walk once more only", async () => {
    const stubborn = network({ "only.test": rateLimited });
    const { p, slept } = pool([m("only.test")], stubborn);
    await expect(
      p.request("eth_getBalance", [
        "0x0000000000000000000000000000000000000015",
        "latest",
      ]),
    ).rejects.toMatchObject({ code: -32005 });
    expect(slept).toEqual([1000]);
    expect(stubborn.log.length).toBe(2);
  });

  test("should send no request to a node inside its Retry-After", async () => {
    const hosts = ["a.test", "b.test", "c.test", "d.test", "e.test"];
    const net = network(
      Object.fromEntries(hosts.map((h) => [h, retryAfter60])),
    );
    const { p, advance } = pool(
      hosts.map((h) => m(h)),
      net,
    );
    await p.serve(balanceAt(20, "0x10"));
    const first = net.log.length;
    for (let i = 0; i < 20; i += 1) {
      advance(1_000);
      await p.serve(balanceAt(21 + i, hex(0x11 + i)));
    }
    expect({ first, later: net.log.length - first }).toEqual({
      first: 5,
      later: 0,
    });
  });

  test("should refuse at once, without a request, while every node cools", async () => {
    const net = network({ "own.test": retryAfter60 });
    const { p, advance, slept } = pool([m("own.test")], net, { ordered: true });
    await p.serve(balanceAt(22, "latest"));
    advance(1_000);
    const refused = (await p.serve(balanceAt(23, "latest"))) as any;
    expect({
      code: refused.error.code,
      asked: net.log.length,
      slept,
    }).toEqual({ code: -32005, asked: 1, slept: [] });
  });

  test("should ask a node again once its Retry-After has passed", async () => {
    let limited = true;
    const net = network({
      "own.test": (c) => (limited ? retryAfter60(c) : { result: "0x9" }),
    });
    const { p, advance } = pool([m("own.test")], net, { ordered: true });
    await p.serve(balanceAt(24, "latest"));
    limited = false;
    advance(60_000);
    const answer = (await p.serve(balanceAt(25, "latest"))) as any;
    expect({ result: answer.result, asked: net.log.length }).toEqual({
      result: "0x9",
      asked: 2,
    });
  });

  test("should not ask a cooling node when the ready ones refuse", async () => {
    let bDown = false;
    const net = network({
      "a.test": retryAfter60,
      "b.test": () =>
        bDown ? { status: 503, raw: "down" } : { result: "0x1" },
    });
    const { p, advance } = pool([m("a.test", { weight: 5 }), m("b.test")], net);
    await p.serve(balanceAt(26, "0x10"));
    bDown = true;
    advance(1_000);
    await p.serve(balanceAt(27, "0x11"));
    expect(net.hosts().filter((h) => h === "a.test").length).toBe(1);
  });

  test("should walk past a rate limit and cool the node that gave it", async () => {
    const net = network({ "a.test": rateLimited, "b.test": ok("0x1") });
    const { p } = pool([m("a.test", { weight: 5 }), m("b.test")], net);
    await p.serve(
      rpc("eth_getBalance", [
        "0x0000000000000000000000000000000000000003",
        "0x10",
      ]),
    );
    await p.serve(
      rpc(
        "eth_getBalance",
        ["0x0000000000000000000000000000000000000004", "0x11"],
        2,
      ),
    );
    expect(net.hosts()).toEqual(["a.test", "b.test", "b.test"]);
  });

  test("should back off a node that keeps refusing for longer each time", async () => {
    const net = network({ "a.test": rateLimited, "b.test": ok("0x1") });
    const { p, advance } = pool([m("a.test", { weight: 9 }), m("b.test")], net);
    const asked: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const before = net.log.filter((l) => l.host === "a.test").length;
      await p.serve(
        rpc(
          "eth_getBalance",
          [`0x${String(200 + i).padStart(40, "0")}`, hex(0x100 + i)],
          i,
        ),
      );
      if (net.log.filter((l) => l.host === "a.test").length > before)
        asked.push(i);
      advance(500);
    }
    // Cooldowns of 1 s, 3 s, 10 s, 30 s at 0.5 s per request: asked at 0, 2, 8, 28.
    expect(asked).toEqual([0, 2, 8, 28]);
  });

  test("should return a revert after one request", async () => {
    const net = network({
      "a.test": () => ({
        error: { code: 3, message: "execution reverted", data: "0x08c379a0" },
      }),
      "b.test": ok("0x1"),
    });
    const { p } = pool([m("a.test", { weight: 5 }), m("b.test")], net);
    const error = (await p
      .request("eth_call", [
        { to: "0x0000000000000000000000000000000000000005", data: "0x" },
        "0x20",
      ])
      .catch((e) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.data).toBe("0x08c379a0");
    expect(net.log.length).toBe(1);
  });

  test("should walk past a pruned node and learn not to ask it again", async () => {
    const pruned: Handler = () => ({
      error: {
        code: 4444,
        message:
          "pruned history unavailable: requested 0, earliest available 46000000",
      },
    });
    const net = network({
      "a.test": pruned,
      "b.test": ok({ hash: "0x0dcc9e08" }),
    });
    const { p } = pool([m("a.test", { weight: 5 }), m("b.test")], net);
    await p.request("eth_getBlockByNumber", ["0x0", false]);
    await p.request("eth_getBlockByNumber", ["0x1", false]);
    expect(net.hosts()).toEqual(["a.test", "b.test", "b.test"]);
  });

  test("should wait out a block the whole pool has not reached, then answer", async () => {
    let calls = 0;
    const lagging: Handler = () =>
      calls++ < 2
        ? { error: { code: -32001, message: "block not found: 0x64" } }
        : { result: "0x1" };
    const net = network({ "a.test": lagging, "b.test": lagging });
    const { p, slept } = pool([m("a.test"), m("b.test")], net);
    expect(
      await p.request<string>("eth_call", [
        { to: "0x0000000000000000000000000000000000000006", data: "0x" },
        "0x64",
      ]),
    ).toBe("0x1");
    expect(slept).toEqual([400]);
  });

  test("should never pass a URL on in an error", async () => {
    const net = network({ "secret-key.test": () => ({ throws: true }) });
    const { p } = pool([m("secret-key.test")], net);
    const error = (await p
      .request("eth_getBalance", [
        "0x0000000000000000000000000000000000000016",
        "0x1",
      ])
      .catch((e) => e)) as Error;
    expect(String(error.message)).not.toContain("secret-key");
  });
});

describe("logs go where they are served", () => {
  const ADDR = "0x8B2293376ee91E0582Dccef49acfC367D490b8d0";
  const logsUpTo =
    (cap: number, message: string): Handler =>
    (call) => {
      if (call.method === "eth_blockNumber") return { result: hex(200_000) };
      const f = call.params[0];
      const from = Number.parseInt(f.fromBlock, 16);
      const to = Number.parseInt(
        f.toBlock === "latest" ? hex(200_000) : f.toBlock,
        16,
      );
      if (to - from > cap)
        return { status: 413, error: { code: -32614, message } };
      return { result: [{ blockNumber: hex(from) }, { blockNumber: hex(to) }] };
    };

  test("should never ask a `none` member, nor an `addressed` one without an address", async () => {
    const net = network({
      "logs.test": ok([]),
      "none.test": ok([]),
      "addr.test": ok([]),
    });
    const { p } = pool(
      [
        m("none.test", { logs: "none", weight: 9 }),
        m("addr.test", { logs: "addressed", weight: 9 }),
        m("logs.test"),
      ],
      net,
    );
    for (let i = 0; i < 5; i += 1)
      await p.serve(
        rpc(
          "eth_getLogs",
          [
            {
              fromBlock: hex(i * 10),
              toBlock: hex(i * 10 + 5),
              topics: ["0x01"],
            },
          ],
          i,
        ),
      );
    expect([...new Set(net.hosts())]).toEqual(["logs.test"]);
  });

  test("should learn that a node needs an address and send it only addressed filters", async () => {
    const net = network({
      "pub.test": (c) =>
        c.params[0].address
          ? { result: [] }
          : {
              error: {
                code: -32701,
                message: "Please specify an address in your request",
              },
            },
      "any.test": ok([]),
    });
    const { p } = pool([m("pub.test", { weight: 9 }), m("any.test")], net);
    await p.request("eth_getLogs", [
      { fromBlock: "0x1", toBlock: "0x2", topics: ["0x01"] },
    ]);
    await p.request("eth_getLogs", [
      { fromBlock: "0x3", toBlock: "0x4", topics: ["0x01"] },
    ]);
    await p.request("eth_getLogs", [
      { address: ADDR, fromBlock: "0x5", toBlock: "0x6" },
    ]);
    expect(net.hosts()).toEqual([
      "pub.test",
      "any.test",
      "any.test",
      "pub.test",
    ]);
  });

  test("should split a range no member takes whole, and merge the windows in order", async () => {
    const net = network({
      "b.test": logsUpTo(50_000, "exceed maximum block range: 50000"),
    });
    const { p } = pool(
      [m("b.test", { logs: "addressed", maxLogSpan: 50_000 })],
      net,
    );
    const logs = await p.request<any[]>("eth_getLogs", [
      { address: ADDR, fromBlock: hex(0), toBlock: hex(199_999) },
    ]);
    const blocks = logs.map((l) => Number.parseInt(l.blockNumber, 16));
    expect(blocks).toEqual([
      0, 50_000, 50_001, 100_001, 100_002, 150_002, 150_003, 199_999,
    ]);
  });

  test("should fail the whole read when one window fails", async () => {
    const net = network({
      "b.test": (call) => {
        const f = call.params[0];
        const span =
          Number.parseInt(f.toBlock, 16) - Number.parseInt(f.fromBlock, 16);
        if (span > 50_000)
          return {
            error: {
              code: -32701,
              message: "exceed maximum block range: 50000",
            },
          };
        // The second window fails every time it is asked, its retry after the cooldown included.
        return Number.parseInt(f.fromBlock, 16) === 50_001
          ? { status: 503, raw: "down" }
          : { result: [{ blockNumber: f.fromBlock }] };
      },
    });
    const { p } = pool(
      [m("b.test", { logs: "addressed", maxLogSpan: 50_000 })],
      net,
    );
    await expect(
      p.request("eth_getLogs", [
        { address: ADDR, fromBlock: hex(0), toBlock: hex(199_999) },
      ]),
    ).rejects.toBeInstanceOf(RpcError);
  });

  test("should hand a range that needs too many windows back to the caller", async () => {
    const net = network({
      "c.test": logsUpTo(1_000, "eth_getLogs is limited to a 1,000 range"),
    });
    const { p } = pool([m("c.test", { maxLogSpan: 1_000 })], net);
    await expect(
      p.request("eth_getLogs", [
        { fromBlock: hex(0), toBlock: hex(500_000), topics: ["0x01"] },
      ]),
    ).rejects.toThrow(/limited to a 1,000 range/);
    expect(net.log.length).toBeLessThanOrEqual(2);
  });

  test("should learn the width a node names and send it no wider window again", async () => {
    const net = network({
      "wide.test": logsUpTo(1_000_000, ""),
      "narrow.test": logsUpTo(1_000, "eth_getLogs is limited to a 1,000 range"),
    });
    const { p } = pool([m("narrow.test", { weight: 9 }), m("wide.test")], net);
    await p.request("eth_getLogs", [
      { fromBlock: hex(0), toBlock: hex(5_000), topics: ["0x01"] },
    ]);
    await p.request("eth_getLogs", [
      { fromBlock: hex(10_000), toBlock: hex(15_000), topics: ["0x01"] },
    ]);
    expect(net.hosts()).toEqual(["narrow.test", "wide.test", "wide.test"]);
  });
});

describe("cache, dedup and what is sent", () => {
  test("should share one in-flight read between two callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const net = network({ "a.test": ok("0xabc") });
    const slow = (async (u: string | URL | Request, i?: RequestInit) => {
      await gate;
      return net.fetchImpl(u, i);
    }) as typeof fetch;
    const p = new RpcPool({
      chainId: 84532,
      nodes: [m("a.test")],
      fetch: slow,
    });
    const call = (id: number) =>
      p.serve(
        rpc(
          "eth_call",
          [
            { to: "0x000000000000000000000000000000000000000a", data: "0x" },
            "latest",
          ],
          id,
        ),
      );
    const both = Promise.all([call(1), call(2)]);
    release();
    const [one, two] = (await both) as any[];
    expect(net.log.length).toBe(1);
    expect([one.id, two.id]).toEqual([1, 2]);
  });

  test("should answer a repeated read from the cache, and skip it when asked fresh", async () => {
    let v = 1;
    const net = network({ "a.test": () => ({ result: hex(v) }) });
    const { p } = pool([m("a.test")], net);
    const q = async (fresh = false) =>
      (
        (await p.serve(
          rpc("eth_call", [
            { to: "0x000000000000000000000000000000000000000b", data: "0x" },
            "latest",
          ]),
          { fresh },
        )) as any
      ).result;
    expect(await q()).toBe("0x1");
    v = 2;
    expect(await q()).toBe("0x1");
    expect(await q(true)).toBe("0x2");
    expect(net.log.length).toBe(2);
  });

  test("should reuse no answer when built without a cache", async () => {
    const net = network({ "a.test": ok([]) });
    const { p } = pool([m("a.test")], net, { cache: false });
    const filter = [
      {
        address: "0x000000000000000000000000000000000000000c",
        fromBlock: "0x1",
        toBlock: "0x2",
      },
    ];
    await p.request("eth_getLogs", filter);
    await p.request("eth_getLogs", filter);
    expect(net.log.length).toBe(2);
  });

  test("should never cache a pinned eth_call", async () => {
    const net = network({ "a.test": ok("0x01") });
    const { p } = pool([m("a.test")], net);
    const call = [
      { to: "0x000000000000000000000000000000000000000b", data: "0x12345678" },
      "0x19",
    ];
    await p.request("eth_call", call);
    await p.request("eth_call", call);
    expect(net.log.length).toBe(2);
  });

  test("should refuse to forward a write, without a request", async () => {
    const net = network({ "a.test": ok("0x1") });
    const { p } = pool([m("a.test")], net);
    await expect(
      p.request("eth_sendRawTransaction", ["0x00"]),
    ).rejects.toMatchObject({ code: -32601 });
    expect(net.log.length).toBe(0);
  });
});

describe("an operator's ordered override", () => {
  test("should ask the first URL first, for NOW and THEN alike", async () => {
    const net = network({ "one.test": ok("0x5"), "two.test": ok("0x5") });
    const { p } = pool([m("one.test"), m("two.test")], net, { ordered: true });
    for (let i = 0; i < 4; i += 1) {
      await p.request("eth_getBalance", [
        `0x${String(i + 1).padStart(40, "0")}`,
        hex(10 + i),
      ]);
      await p.serve(rpc("eth_blockNumber"), { fresh: true });
    }
    expect(new Set(net.hosts())).toEqual(new Set(["one.test"]));
  });

  test("should fall over to the next URL only when the first refuses", async () => {
    const net = network({ "one.test": rateLimited, "two.test": ok("0x5") });
    const { p } = pool([m("one.test"), m("two.test")], net, { ordered: true });
    await p.request("eth_getBalance", [
      "0x0000000000000000000000000000000000000001",
      "0x1",
    ]);
    await p.request("eth_getBalance", [
      "0x0000000000000000000000000000000000000002",
      "0x2",
    ]);
    expect(net.hosts()).toEqual(["one.test", "two.test", "two.test"]);
  });

  test("should ask an operator's node for the chain id instead of assuming it", async () => {
    const net = network({ "one.test": ok("0x1") });
    const { p } = pool([m("one.test")], net, { ordered: true });
    expect(await p.request<string>("eth_chainId")).toBe("0x1");
  });
});

describe("createRpcPool", () => {
  test("should read through the chain's free nodes by default", () => {
    expect(createRpcPool({ chainId: 84532 }).describe().length).toBe(5);
  });

  test("should let a caller's own URLs replace the free nodes, in order", async () => {
    const net = network({ "own.test": ok("0x1") });
    const p = createRpcPool({
      chainId: 84532,
      urls: ["https://own.test"],
      fetch: net.fetchImpl,
    });
    expect([await p.request("eth_chainId"), net.hosts()]).toEqual([
      "0x1",
      ["own.test"],
    ]);
  });

  test("should refuse a chain without free nodes when no URL is given", () => {
    expect(() => createRpcPool({ chainId: 31337 })).toThrow(/RPC_URLS/);
  });
});
