import path from "path";
import { Contract, Network } from "ethers";
import bermuda from "@bermuda/sdk";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import {
  queryFilterBatched,
  mergeCommitmentEvents,
  RetryingJsonRpcProvider,
  rpcUrls,
  redactRpc,
} from "./utils";

export const chains = ["base-sepolia", "linea-sepolia", "plasma-testnet", "gnosis", "robinhood-testnet", "arc-testnet", "bermuda-boat-base-fork"];

// Chains whose SDK slug does not describe them, and what to override.
//
// `bermuda-boat-base-fork` is the Bermuda Boat demo chain: an anvil FORK of Base
// reporting Base's own chain id (8453), with a pool restored from a snapshot.
// There is no SDK slug for it. The only usable base is `testenv` — the one slug
// `getConfig` does not overlay with a live server config — and every value that
// matters then has to be replaced, because `testenv` bakes chainId 31337 and a
// completely different pool address. Left unoverridden, the crawler would index
// the wrong pool on the wrong chain and write an empty artifact.
//
// This is the same override shape the Bermuda Boat extension itself uses.
const CHAIN_OVERRIDES = {
  "bermuda-boat-base-fork": {
    slug: "testenv",
    config: {
      chainId: 8453n,
      // The pool this deployment restores from `deployer/pool-state/8453/`.
      pool: "0xc6e7DF5E7b4f2A278906862b61205850344D4e7d",
      // The height the snapshot was rebased onto when the fork was stood up.
      //
      // Load-bearing: `testenv` bakes `startBlock: 0`, and on a fork that means
      // `queryFilterBatched` would walk from Base GENESIS in 1000-block batches —
      // tens of thousands of requests, most of them forwarded upstream by anvil.
      // The pool cannot have events before this block, because it did not exist.
      //
      // Only used until the artifact exists; after the first successful crawl
      // `fromBlock` comes from the file's own `block` field. If the fork is ever
      // rebuilt at a new height this value goes stale in the safe direction — a
      // low floor costs a slower scan, never a missed event.
      startBlock: 49369729n,
    },
  },
};

// Resolve a `chains` entry to a configured SDK instance.
//
// Exported because this function IS the definition of what a `chains` entry
// means. Entries used to be SDK slugs one-for-one, so every caller — including
// main.test.js — could just do `bermuda(entry)`. `bermuda-boat-base-fork` has no
// slug of its own (it is `testenv` plus overrides), so that assumption no longer
// holds, and keeping the knowledge in one exported place is what stops the
// crawler and its tests from disagreeing about which pool a name refers to.
export function sdkFor(chain) {
  const override = CHAIN_OVERRIDES[chain];
  return override ? bermuda(override.slug, override.config) : bermuda(chain);
}

// Crawl one chain's pool(s) using a specific provider. Idempotent: reads existing
// events + block from disk, fetches only the delta, merges, and writes.
async function crawlChain(sdk, provider) {
  const { pool, chainId, startBlock } = sdk.config;

  const currentPoolAddress = await pool.getAddress();
  const toBlock = BigInt(await provider.getBlockNumber());
  const chainDirPath = path.join(__dirname, String(chainId));

  // Try to find existing pool addresses based on the directory names that are
  // nested within the directory of the current chain.
  let existingPoolAddresses = [];
  try {
    const chainDirElements = await readdir(chainDirPath, {
      withFileTypes: true,
    });
    existingPoolAddresses = chainDirElements
      .filter((elem) => elem.isDirectory() && elem.name.startsWith("0x"))
      .map((elem) => elem.name);
  } catch {}

  // Merge the current pool address with the existing pool addresses,
  // deduplicate and normalize them to be lowercased.
  const poolAddresses = [currentPoolAddress, ...existingPoolAddresses]
    .map((address) => address.toLowerCase())
    .filter((address, index, array) => array.indexOf(address) === index);

  // For every chain there might be multiple pool deployments we need to fetch
  // data for.
  for (const address of poolAddresses) {
    const contract = new Contract(address, sdk.POOL_ABI, provider);
    const addressDirPath = path.join(chainDirPath, address);
    const gitKeepFilePath = path.join(addressDirPath, ".gitkeep");

    // -------------------------
    // --- Commitment Events ---
    // -------------------------
    const fileName = "commitment-events.json";
    const filePath = path.join(addressDirPath, fileName);

    // Try to load the most recent block number and existing events from the
    // file and if there's no file found, then default to the `startBlock`
    // from the SDK config and an empty events array.
    let fromBlock = startBlock;
    let oldEvents = [];
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

      fromBlock = BigInt(parsed.block);
      oldEvents = parsed.events;
    } catch {}

    // Load new events.
    const filter = contract.filters.NewCommitment();
    const rawEvents = await queryFilterBatched(
      fromBlock,
      toBlock,
      contract,
      filter,
    );
    const newEvents = rawEvents.map((event) => ({
      commitment: event.args.commitment,
      index: String(event.args.index),
      encryptedOutput: event.args.encryptedOutput,
    }));

    // Merge old events with the new ones.
    const events = mergeCommitmentEvents(oldEvents, newEvents);

    // Write updated list of events alongside the most recent block number to
    // the file.
    const result = {
      block: String(toBlock),
      events,
    };

    const output = JSON.stringify(result);

    await mkdir(addressDirPath, { recursive: true });
    await writeFile(filePath, output, "utf-8");

    // Ensure .gitkeep file is present.
    // Such .gitkeep files are used to add new, empty directories via regular
    // commits from a local machine so that CI can pick them up and add
    // artifacts to them as only CI should create artifacts to ensure
    // consistency.
    await writeFile(gitKeepFilePath, "", "utf-8");
  }
}

// Crawl a chain, trying each configured RPC URL in order (keyed Alchemy first,
// then public fallbacks) until one succeeds. Throws only if EVERY endpoint fails.
async function crawlChainWithFailover(chain) {
  const sdk = sdkFor(chain);
  const { chainId } = sdk.config;
  // Static network (chain id known from the SDK) so ethers never spends a call
  // on the eth_chainId probe — fewer requests + one less rate-limit surface.
  const network = Network.from(Number(chainId));
  const urls = rpcUrls(chainId);

  let lastError;
  for (const url of urls) {
    try {
      const provider = new RetryingJsonRpcProvider(url, network, {
        staticNetwork: network,
      });
      await crawlChain(sdk, provider);
      provider.destroy();
      return { chain, url };
    } catch (error) {
      lastError = error;
      console.warn(
        `[chain-state] ${chain}: RPC ${redactRpc(url)} failed (${error?.shortMessage ?? error?.message ?? error}); trying next endpoint`,
      );
    }
  }
  throw lastError ?? new Error(`${chain}: all RPC endpoints failed`);
}

async function main() {
  // Crawl every chain INDEPENDENTLY (allSettled, not all): one chain's RPCs being
  // down must not stop the others from indexing + committing their data.
  const settled = await Promise.allSettled(chains.map(crawlChainWithFailover));

  const failed = [];
  settled.forEach((outcome, index) => {
    const chain = chains[index];
    if (outcome.status === "fulfilled") {
      console.log(`[chain-state] OK ${chain} via ${redactRpc(outcome.value.url)}`);
    } else {
      failed.push(chain);
      const reason = outcome.reason;
      console.error(
        `[chain-state] FAILED ${chain}: ${reason?.shortMessage ?? reason?.message ?? reason}`,
      );
    }
  });

  if (failed.length > 0) {
    console.error(
      `[chain-state] ${failed.length}/${chains.length} chain(s) failed: ${failed.join(", ")}`,
    );
    // Partial success still commits the chains that indexed (data stays
    // available). Only a TOTAL outage — every chain failed — fails the CI run.
    if (failed.length === chains.length) {
      process.exitCode = 1;
    }
  }
}

if (import.meta.main) {
  main();
}
