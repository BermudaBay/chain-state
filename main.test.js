import { expect, test } from "bun:test";
import bermuda from "@bermuda/sdk";
import { chains } from "./main";
import { rpcUrls, isRateLimit } from "./utils";

test("should include robinhood-testnet in the crawled chains", () => {
  // Arrange
  const slug = "robinhood-testnet";

  // Act
  const isConfigured = chains.includes(slug);

  // Assert
  expect(isConfigured).toBe(true);
});

// Cross-repo dependency (deployments#32): chain-state carries only the crawl
// slug list; the chainId -> RPC/pool/token config lives in `@bermuda/sdk`
// (src/chain.ts + src/config.ts), which is pinned here as a git dependency.
// The SDK now ships a `robinhood-testnet` entry (chainId 46630n, public keyless
// provider) and this repo bumps the pinned SDK ref to the main commit that
// added it, so the guard is now active.
test("should resolve robinhood-testnet to chain id 46630 via the sdk", () => {
  // Arrange
  const slug = "robinhood-testnet";

  // Act
  const { chainId } = bermuda(slug).config;

  // Assert
  expect(chainId).toBe(46630n);
});

// Every crawled chain must have at least one RPC endpoint configured.
test("every crawled chain resolves to at least one RPC url", () => {
  for (const slug of chains) {
    const { chainId } = bermuda(slug).config;
    const urls = rpcUrls(chainId);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("https://"))).toBe(true);
  }
});

// The Alchemy API key must never be baked into source: it is read from
// ALCHEMY_API_KEY. Without it, only keyless public fallbacks are returned.
test("rpcUrls omits the keyed endpoint when ALCHEMY_API_KEY is unset", () => {
  const prev = process.env.ALCHEMY_API_KEY;
  delete process.env.ALCHEMY_API_KEY;
  try {
    for (const slug of chains) {
      const { chainId } = bermuda(slug).config;
      expect(rpcUrls(chainId).some((u) => u.includes("g.alchemy.com"))).toBe(false);
    }
  } finally {
    if (prev !== undefined) process.env.ALCHEMY_API_KEY = prev;
  }
});

test("rpcUrls leads with the keyed Alchemy endpoint when ALCHEMY_API_KEY is set", () => {
  const prev = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = "TEST_KEY_123";
  try {
    const urls = rpcUrls(84532n); // base-sepolia
    expect(urls[0]).toBe("https://base-sepolia.g.alchemy.com/v2/TEST_KEY_123");
    expect(urls.length).toBeGreaterThan(1); // + public fallbacks
  } finally {
    if (prev === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = prev;
  }
});

// The bug that broke CI: only -32007 was treated as a rate limit, so Alchemy's
// -32011 ("request limit reached") was never retried.
test("isRateLimit catches the rate-limit signals that broke the crawler", () => {
  expect(isRateLimit({ error: { code: -32011, message: "request limit reached" } })).toBe(true);
  expect(isRateLimit({ error: { code: -32007 } })).toBe(true);
  expect(isRateLimit({ code: 429 })).toBe(true);
  expect(isRateLimit({ info: { status: 429 } })).toBe(true);
  expect(isRateLimit({ message: "Too Many Requests" })).toBe(true);
  expect(isRateLimit({ error: { code: -32000, message: "execution reverted" } })).toBe(false);
  expect(isRateLimit(null)).toBe(false);
});
