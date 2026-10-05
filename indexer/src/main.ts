import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config";
import { Follower } from "./follower";
import { createRpcPool } from "./rpc-pool";
import { retiredRpcWarning } from "./rpc-urls";
import { createApp } from "./server";
import { Store } from "./store";

/** Some free nodes answer 403 to a server-side request without a User-Agent. */
const USER_AGENT = "bermuda-chain-state-indexer";

/** A fetch that sends `userAgent` with every request. */
export function withUserAgent(
  base: typeof fetch,
  userAgent: string,
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", userAgent);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}

/** Start the indexer: open the database, follow the chain, serve HTTP. */
export async function startIndexer(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(`[indexer] ${line}`),
): Promise<{ url: string; stop(): Promise<void> }> {
  const config = loadConfig(env);
  const retired = retiredRpcWarning(env);
  if (retired) log(retired);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = Store.open(config.dbPath, {
    chainId: String(config.chainId),
    pool: config.pool,
    registry: config.registry,
    startBlock: config.startBlock,
  });
  // No read cache: the follower never asks the same question twice except to retry a range
  // that failed verification, and that retry must reach a node. In-flight reads are still shared.
  const rpc = createRpcPool({
    chainId: config.chainId,
    urls: config.rpcUrls,
    cache: false,
    fetch: withUserAgent(fetch, USER_AGENT),
  });
  const follower = new Follower({
    store,
    rpc,
    chainId: config.chainId,
    contracts: { pool: config.pool, registry: config.registry },
    multicall: config.multicall,
    height: config.height,
    confirmations: config.confirmations,
    intervalSeconds: config.intervalSeconds,
    log,
  });
  const app = createApp({
    store,
    follower,
    chainId: config.chainId,
    pool: config.pool,
    confirmations: config.confirmations,
    intervalSeconds: config.intervalSeconds,
  });
  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    error: () =>
      new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  });
  log(
    `chain ${config.chainId}, pool ${config.pool}, from block ${config.startBlock}, ` +
      `every ${config.intervalSeconds}s, ${config.confirmations} confirmations, ` +
      (config.rpcUrls
        ? `${config.rpcUrls.length} RPC URL(s) from the override`
        : "the free nodes") +
      `; listening on ${server.port}`,
  );
  follower.start();
  return {
    url: `http://127.0.0.1:${server.port}`,
    async stop() {
      await follower.stop();
      server.stop(true);
      store.close();
    },
  };
}

if (import.meta.main) {
  const indexer = await startIndexer(process.env);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await indexer.stop();
      process.exit(0);
    });
  }
}
