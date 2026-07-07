import { expect, test } from "bun:test";
import bermuda from "@bermuda/sdk";
import { chains } from "./main";

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
