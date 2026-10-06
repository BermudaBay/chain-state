import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const POOL = "0x00000000000000000000000000000000000000aa";
const REGISTRY = "0x00000000000000000000000000000000000000bb";

describe("loadConfig", () => {
  test("should take the addresses and start block from the sdk preset", () => {
    const config = loadConfig({ CHAIN_ID: "84532" });
    expect([
      config.chainId,
      config.pool,
      config.registry,
      config.multicall,
      config.startBlock,
      config.height,
    ]).toEqual([
      84532,
      "0x8b2293376ee91e0582dccef49acfc367d490b8d0",
      "0xdfedaf390297e6d6bbaac6a1e127cdda25b87e6a",
      "0x961cdc889f9ab59cff6e1cd20e771a7932883c6f",
      47293435,
      23,
    ]);
  });

  test("should default to a one-minute tick, twelve confirmations and port 4200", () => {
    const config = loadConfig({ CHAIN_ID: "84532" });
    expect([config.intervalSeconds, config.confirmations, config.port]).toEqual(
      [60, 12, 4200],
    );
  });

  test("should read through the free nodes when no override is set", () => {
    expect(loadConfig({ CHAIN_ID: "84532" }).rpcUrls).toBeUndefined();
  });

  test("should let RPC_URLS replace the free nodes, in order", () => {
    const config = loadConfig({
      CHAIN_ID: "84532",
      RPC_URLS: "https://one.test,https://two.test",
    });
    expect(config.rpcUrls).toEqual(["https://one.test", "https://two.test"]);
  });

  test("should read a keyed URL only from RPC_URLS_FILE", () => {
    const keyed = "https://base-sepolia.g.alchemy.com/v2/SECRET_KEY_123";
    const config = loadConfig(
      { CHAIN_ID: "84532", RPC_URLS_FILE: "/run/secrets/rpc_urls" },
      () => keyed,
    );
    expect(config.rpcUrls).toEqual([keyed]);
  });

  test("should share the free nodes with no other process when RPC_SHARED_BY is unset", () => {
    expect(loadConfig({ CHAIN_ID: "84532" }).rpcSharedBy).toBe(1);
  });

  test("should read the processes sharing the free nodes from RPC_SHARED_BY", () => {
    expect(
      loadConfig({ CHAIN_ID: "84532", RPC_SHARED_BY: "4" }).rpcSharedBy,
    ).toBe(4);
  });

  test("should refuse an RPC_SHARED_BY that is not a positive integer", () => {
    expect(() =>
      loadConfig({ CHAIN_ID: "84532", RPC_SHARED_BY: "0x4" }),
    ).toThrow(/RPC_SHARED_BY/);
  });

  test("should take address and start block overrides", () => {
    const config = loadConfig({
      CHAIN_ID: "31337",
      RPC_URLS: "http://anvil:8545",
      POOL_ADDRESS: POOL,
      ACCOUNT_REGISTRY_ADDRESS: REGISTRY,
      MULTICALL_ADDRESS: POOL,
      START_BLOCK: "5",
      INDEX_CONFIRMATIONS: "0",
      INDEX_INTERVAL_SECONDS: "2",
    });
    expect([
      config.pool,
      config.registry,
      config.multicall,
      config.startBlock,
      config.confirmations,
      config.intervalSeconds,
    ]).toEqual([POOL, REGISTRY, POOL, 5, 0, 2]);
  });

  test("should refuse a missing chain id", () => {
    expect(() => loadConfig({})).toThrow(/CHAIN_ID/);
  });

  test("should refuse a chain without an sdk preset", () => {
    expect(() => loadConfig({ CHAIN_ID: "1" })).toThrow(
      /no sdk preset for chain 1/,
    );
  });

  test("should refuse a local chain without RPC_URLS", () => {
    expect(() => loadConfig({ CHAIN_ID: "31337" })).toThrow(/RPC_URLS/);
  });

  test("should refuse a malformed setting", () => {
    expect(() =>
      loadConfig({ CHAIN_ID: "84532", INDEX_INTERVAL_SECONDS: "0" }),
    ).toThrow(/INDEX_INTERVAL_SECONDS/);
  });

  test("should refuse a malformed address", () => {
    expect(() =>
      loadConfig({ CHAIN_ID: "84532", POOL_ADDRESS: "0x123" }),
    ).toThrow(/POOL_ADDRESS/);
  });
});
