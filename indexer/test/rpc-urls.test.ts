import { describe, expect, test } from "bun:test";
import { rpcChainOf } from "../src/rpc-nodes";
import {
  isKeyedRpcUrl,
  legacyRpcEnv,
  readRpcUrls,
  redactRpcUrls,
} from "../src/rpc-urls";

const KEYED = "https://base-sepolia.g.alchemy.com/v2/SECRET_KEY_123";

describe("readRpcUrls", () => {
  test("should be undefined when neither RPC_URLS nor RPC_URLS_FILE is set", () => {
    expect(readRpcUrls({ env: {} })).toBeUndefined();
  });

  test("should read RPC_URLS in order, separated by commas, spaces or newlines", () => {
    expect(
      readRpcUrls({
        env: { RPC_URLS: "https://a.test, https://b.test\nhttp://anvil:8545" },
      }),
    ).toEqual(["https://a.test", "https://b.test", "http://anvil:8545"]);
  });

  test("should read RPC_URLS_FILE through the given reader, skipping comments", () => {
    const readFile = (path: string) =>
      path === "/run/secrets/rpc_urls" ? `# primary\n${KEYED}\n` : "";
    expect(
      readRpcUrls({
        env: { RPC_URLS_FILE: "/run/secrets/rpc_urls" },
        readFile,
      }),
    ).toEqual([KEYED]);
  });

  test("should refuse a keyed URL in RPC_URLS, which is not a secret", () => {
    expect(() => readRpcUrls({ env: { RPC_URLS: KEYED } })).toThrow(
      /RPC_URLS_FILE/,
    );
  });

  test("should refuse both at once", () => {
    expect(() =>
      readRpcUrls({
        env: { RPC_URLS: "http://a.test", RPC_URLS_FILE: "/x" },
        readFile: () => "http://b.test",
      }),
    ).toThrow(/not both/);
  });

  test("should refuse an entry that is not an http(s) URL, without echoing it", () => {
    const error = (() => {
      try {
        readRpcUrls({
          env: { RPC_URLS_FILE: "/x" },
          readFile: () => `${KEYED}\nftp://SECRET_KEY_123`,
        });
      } catch (e) {
        return e as Error;
      }
    })();
    expect([
      error?.message.includes("entry 2"),
      error?.message.includes("SECRET_KEY_123"),
    ]).toEqual([true, false]);
  });
});

describe("keyed URLs", () => {
  test("should recognise the keyed shapes and leave the free nodes alone", () => {
    expect([
      isKeyedRpcUrl(KEYED),
      isKeyedRpcUrl("https://mainnet.infura.io/v3/abc"),
      isKeyedRpcUrl("https://x.quiknode.pro/token/"),
      isKeyedRpcUrl("https://lb.drpc.org/ogrpc?network=base&dkey=abc"),
      isKeyedRpcUrl("https://sepolia.base.org"),
    ]).toEqual([true, true, true, true, false]);
  });

  test("should redact every URL in a text to its scheme and host", () => {
    expect(redactRpcUrls(`failed: ${KEYED} refused`)).toBe(
      "failed: https://base-sepolia.g.alchemy.com/… refused",
    );
  });
});

describe("legacyRpcEnv", () => {
  test("should name every retired RPC variable that is set", () => {
    expect(
      legacyRpcEnv({
        RPC: "x",
        RPC_POOL: "x",
        BASE_RPC: "x",
        RPC_UPSTREAM: "x",
        RPC_URLS_BASE_SEPOLIA: "x",
        RPC_URLS: "x",
        RPC_URLS_FILE: "x",
      }).sort(),
    ).toEqual([
      "BASE_RPC",
      "RPC",
      "RPC_POOL",
      "RPC_UPSTREAM",
      "RPC_URLS_BASE_SEPOLIA",
    ]);
  });
});

describe("the free nodes", () => {
  test("should list Base Sepolia's measured nodes, logs only where logs were served", () => {
    const byHost = Object.fromEntries(
      rpcChainOf(84532)!.nodes.map((n) => [new URL(n.url).host, n]),
    );
    expect([
      byHost["base-sepolia-rpc.publicnode.com"].logs,
      byHost["sepolia.base.org"].maxLogSpan,
    ]).toEqual(["addressed", 500]);
  });

  test("should keep out the node that answers past its head with an empty list", () => {
    expect(rpcChainOf(84532)!.nodes.some((n) => n.url.includes("drpc"))).toBe(
      false,
    );
  });

  test("should have no free nodes for a local chain", () => {
    expect(rpcChainOf(31337)).toBeUndefined();
  });

  test("should carry no key in any URL", () => {
    for (const id of [84532, 1, 100, 9746, 59141, 46630, 5042002]) {
      for (const n of rpcChainOf(id)!.nodes) {
        expect([isKeyedRpcUrl(n.url), n.url.startsWith("https://")]).toEqual([
          false,
          true,
        ]);
      }
    }
  });
});
