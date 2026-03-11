import path from "path";
import { Contract } from "ethers";
import bermuda from "@bermuda/sdk";
import { mergeCommitmentEvents, queryFilterBatched } from "./utils";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";

const chains = ["base-sepolia"];

async function main() {
  // Iterate over all the listed chains.
  for (const chain of chains) {
    const sdk = bermuda(chain);

    const { pool, chainId, startBlock, provider } = sdk.config;

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
}

main();
