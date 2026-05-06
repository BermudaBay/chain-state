import { JsonRpcProvider } from "ethers";

const RATE_LIMIT_CODE = -32007;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RetryingJsonRpcProvider extends JsonRpcProvider {
  constructor(url, network, options = {}) {
    const {
      maxRetries = 5,
      baseDelayMs = 250,
      maxDelayMs = 8_000,
      ...rest
    } = options;

    super(url, network, rest);

    this.url = url;
    this.attempt = 0;
    this.nextAllowedTime = 0;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  async _send(payload) {
    // Respect any backoff window left over from a previous call.
    const wait = this.nextAllowedTime - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }

    while (true) {
      const results = await super._send(payload);

      // _send returns an array (one entry per request in the batch).
      // If any entry is a rate-limit error, back off and retry the whole
      // payload.
      const rateLimited = results.some(
        (r) => r && r.error && r.error.code === RATE_LIMIT_CODE,
      );

      if (!rateLimited) {
        this.attempt = 0;
        return results;
      }

      if (this.attempt >= this.maxRetries) {
        this.attempt = 0;
        return results;
      }

      // Exponential backoff with jitter: 250ms, 500ms, 1s, 2s, 4s, capped at 8s.
      const delay = Math.min(
        this.baseDelayMs * 2 ** this.attempt,
        this.maxDelayMs,
      );

      const jitter = Math.random() * delay * 0.25;
      const jitteredDelay = delay + jitter;

      console.log(
        `Hitting rate limits when querying ${this.url}... Backing off for ${jitteredDelay}ms`,
      );

      this.nextAllowedTime = Date.now() + jitteredDelay;
      await sleep(jitteredDelay);

      this.attempt++;
    }
  }
}

export async function queryFilterBatched(fromBlock, toBlock, contract, filter) {
  const batchSize = 1000n;
  let batchedEvents = [];
  let i = fromBlock;
  let batchToBlock;
  const currentBlockNumber = await contract.runner.provider.getBlockNumber();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    batchToBlock = i + batchSize;
    if (batchToBlock > currentBlockNumber) {
      batchToBlock = currentBlockNumber;
    }
    const events = await contract.queryFilter(filter, i, batchToBlock);
    batchedEvents = [...batchedEvents, ...events];
    i += batchSize;
    if (i >= toBlock) {
      break;
    }
  }
  return batchedEvents;
}

export function mergeCommitmentEvents(a, b) {
  const events = new Map();

  for (const event of a) {
    events.set(event.index, event);
  }

  for (const event of b) {
    events.set(event.index, event);
  }

  return Array.from(events.values());
}
