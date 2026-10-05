import bermuda from "@bermuda/sdk";
import { readFileSync } from "node:fs";
import { rpcChainOf } from "./rpc-nodes";
import { readRpcUrls } from "./rpc-urls";

/** The sdk presets by chain id. */
const PRESETS: Readonly<Record<number, string>> = {
  100: "gnosis",
  84532: "base-sepolia",
  9746: "plasma-testnet",
  59141: "linea-sepolia",
  46630: "robinhood-testnet",
  5042002: "arc-testnet",
  31337: "testenv",
};

export interface Config {
  chainId: number;
  pool: string;
  registry: string;
  multicall?: string;
  startBlock: number;
  /** The pool's commitment tree height. */
  height: number;
  intervalSeconds: number;
  confirmations: number;
  dbPath: string;
  port: number;
  /** The operator's `RPC_URLS` / `RPC_URLS_FILE`, replacing the free nodes. Never logged. */
  rpcUrls?: string[];
}

type Env = Record<string, string | undefined>;

/**
 * The service's settings, from the environment and the chain's sdk preset.
 *
 *   CHAIN_ID                                     required; picks the sdk preset
 *   POOL_ADDRESS, ACCOUNT_REGISTRY_ADDRESS,      address overrides, named as in the
 *   MULTICALL_ADDRESS                            compliance engine's sdk overrides
 *   START_BLOCK                                  overrides the preset's start block
 *   INDEX_INTERVAL_SECONDS (60), INDEX_CONFIRMATIONS (12), DB_PATH, PORT (4200)
 *   RPC_URLS / RPC_URLS_FILE                     replace the free nodes; never logged
 */
export function loadConfig(
  env: Env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Config {
  const chainId = integer(env, "CHAIN_ID", undefined, { positive: true });
  const slug = PRESETS[chainId];
  if (!slug) throw new Error(`no sdk preset for chain ${chainId}`);

  const overrides: Record<string, string> = {};
  for (const [key, name] of [
    ["pool", "POOL_ADDRESS"],
    ["accountRegistry", "ACCOUNT_REGISTRY_ADDRESS"],
    ["multiCall", "MULTICALL_ADDRESS"],
  ] as const) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(value))
      throw new Error(`${name} must be an address`);
    overrides[key] = value;
  }
  const preset = bermuda(slug, overrides).config as any;
  const pool = addressOf(preset.pool);
  const registry = addressOf(preset.accountRegistry);
  if (!pool)
    throw new Error(`the ${slug} preset has no pool: set POOL_ADDRESS`);
  if (!registry) {
    throw new Error(
      `the ${slug} preset has no account registry: set ACCOUNT_REGISTRY_ADDRESS`,
    );
  }

  const rpcUrls = readRpcUrls({ env, readFile });
  if (!rpcUrls && !rpcChainOf(chainId)) {
    throw new Error(
      `no free nodes are known for chain ${chainId}: set RPC_URLS or RPC_URLS_FILE`,
    );
  }

  return {
    chainId,
    pool,
    registry,
    multicall: addressOf(preset.multiCall),
    startBlock: integer(env, "START_BLOCK", Number(preset.startBlock)),
    height: Number(preset.merkleTreeHeight ?? 23),
    intervalSeconds: integer(env, "INDEX_INTERVAL_SECONDS", 60, {
      positive: true,
    }),
    confirmations: integer(env, "INDEX_CONFIRMATIONS", 12),
    dbPath: env.DB_PATH || "data/indexer.sqlite",
    port: integer(env, "PORT", 4200),
    rpcUrls,
  };
}

function integer(
  env: Env,
  name: string,
  fallback: number | undefined,
  opts: { positive?: boolean } = {},
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    (opts.positive && value === 0)
  ) {
    throw new Error(
      `${name} must be a ${opts.positive ? "positive" : "non-negative"} integer`,
    );
  }
  return value;
}

/** A contract's or a string's address, lowercase; undefined when unset. */
function addressOf(value: unknown): string | undefined {
  const address =
    typeof value === "string"
      ? value
      : (value as { target?: unknown } | undefined)?.target;
  return typeof address === "string" && address !== ""
    ? address.toLowerCase()
    : undefined;
}
