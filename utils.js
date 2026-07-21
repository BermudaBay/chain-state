import { JsonRpcProvider } from "ethers";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Different RPC providers signal "slow down" with different JSON-RPC error codes
// (-32005 / -32007 / -32011 / -32016 …), an HTTP 429, or just a message. We MUST
// catch them all: matching only -32007 let Alchemy's -32011 ("request limit
// reached") sail through un-retried, so it threw on the opening eth_chainId and
// killed the entire crawl (chain-state CI red every run, 2026-07-21).
const RATE_LIMIT_CODES = new Set([-32005, -32007, -32011, -32016, -32098, 429]);
const RATE_LIMIT_RE =
  /rate.?limit|request limit|too many requests|capacity|exceeded|throttl|-32011/i;

// Accepts either a thrown ethers error, or a single JSON-RPC batch result object
// ({ error: { code, message } }). Checks code, HTTP status, and message text.
export function isRateLimit(err) {
  if (!err) return false;
  const code = err.code ?? err.error?.code ?? err.info?.error?.code;
  if (RATE_LIMIT_CODES.has(code)) return true;
  const status = err.status ?? err.info?.status ?? err.info?.response?.status;
  if (status === 429) return true;
  const msg =
    err.message ?? err.error?.message ?? err.shortMessage ?? err.info?.error?.message ?? "";
  return typeof msg === "string" && RATE_LIMIT_RE.test(msg);
}

// A single-endpoint JSON-RPC provider that backs off + retries on rate limits.
// Cross-endpoint FAILOVER is handled one level up in main.js (crawlChain iterates
// the per-chain URL list), which keeps this class simple and predictable for the
// crawler's getLogs-heavy workload.
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

  async _backoff() {
    // Exponential backoff with jitter: 250ms, 500ms, 1s, 2s, 4s, capped at 8s.
    const delay = Math.min(this.baseDelayMs * 2 ** this.attempt, this.maxDelayMs);
    const jittered = delay + Math.random() * delay * 0.25;
    console.log(
      `Hitting rate limits when querying ${this.url}... Backing off for ${Math.round(jittered)}ms`,
    );
    this.nextAllowedTime = Date.now() + jittered;
    await sleep(jittered);
    this.attempt++;
  }

  async _send(payload) {
    // Respect any backoff window left over from a previous call.
    const wait = this.nextAllowedTime - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }

    while (true) {
      let results;
      try {
        results = await super._send(payload);
      } catch (err) {
        // HTTP-level throttling (429) and transport errors surface as a THROW,
        // not a per-request { error } inside the batch body — retry those too.
        if (isRateLimit(err) && this.attempt < this.maxRetries) {
          await this._backoff();
          continue;
        }
        throw err;
      }

      // _send returns an array (one entry per request in the batch). If any
      // entry is a rate-limit error, back off and retry the whole payload.
      const rateLimited = results.some((r) => r && r.error && isRateLimit(r));

      if (!rateLimited || this.attempt >= this.maxRetries) {
        this.attempt = 0;
        return results;
      }

      await this._backoff();
    }
  }
}

// --- RPC endpoints ---------------------------------------------------------
//
// The crawler builds its own provider URLs here rather than reading the SDK's
// baked `provider` field, for two reasons:
//   1. FAILOVER — a per-chain ordered list (keyed Alchemy first for its superior
//      eth_getLogs support, then keyless public RPCs) so one throttled/downed
//      endpoint doesn't stop indexing.
//   2. SECRETS — the Alchemy API key is NEVER committed. It is read from the
//      ALCHEMY_API_KEY env var (a GitHub Actions secret; see .github/workflows/
//      ci.yml). When it's unset (local dev), the keyed endpoint is simply omitted
//      and only the public fallbacks are used.

const ALCHEMY_SUBDOMAIN = {
  84532: "base-sepolia",
  59141: "linea-sepolia",
  9746: "plasma-testnet",
  100: "gnosis-mainnet",
  46630: "robinhood-testnet",
  5042002: "arc-testnet",
};

// Keyless public fallbacks, health-ranked (mirrors mobile-agent/worklet/chains.mjs;
// gnosis from chainlist). Order matters — tried after the keyed endpoint.
const PUBLIC_RPCS = {
  84532: [
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
  ],
  59141: [
    "https://rpc.sepolia.linea.build",
    "https://linea-sepolia-rpc.publicnode.com",
    "https://linea-sepolia.drpc.org",
  ],
  9746: ["https://testnet-rpc.plasma.to"],
  100: [
    "https://rpc.gnosischain.com",
    "https://gnosis.drpc.org",
    "https://gnosis-rpc.publicnode.com",
  ],
  46630: [
    "https://rpc.testnet.chain.robinhood.com/rpc",
    "https://robinhood-testnet.drpc.org",
  ],
  5042002: [
    "https://rpc.testnet.arc.network",
    "https://arc-testnet.drpc.org",
    "https://rpc.blockdaemon.testnet.arc.network",
  ],
};

// Ordered RPC URL list for a chain id: keyed Alchemy first (only if
// ALCHEMY_API_KEY is set), then the public fallbacks.
export function rpcUrls(chainId) {
  const id = Number(chainId);
  const key = process.env.ALCHEMY_API_KEY;
  const subdomain = ALCHEMY_SUBDOMAIN[id];
  const keyed =
    key && subdomain ? [`https://${subdomain}.g.alchemy.com/v2/${key}`] : [];
  const publics = PUBLIC_RPCS[id] ?? [];
  const urls = [...keyed, ...publics];
  if (urls.length === 0) {
    throw new Error(`chain-state: no RPC URLs configured for chain id ${id}`);
  }
  return urls;
}

// Redact the Alchemy key from a URL for safe logging.
export function redactRpc(url) {
  return url.replace(/(\/v2\/)[^/?#]+/, "$1***");
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
