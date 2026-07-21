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

export const chains = ["base-sepolia", "linea-sepolia", "plasma-testnet", "gnosis", "robinhood-testnet", "arc-testnet"];

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
  const sdk = bermuda(chain);
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
