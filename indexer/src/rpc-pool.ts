/**
 * A polite JSON-RPC client over a pool of free nodes.
 *
 * A copy of the free-node pool the sdk ships as its default transport (`createRpcPool`), first
 * measured and built in psd. It keeps the sdk's routing rules, options and `createRpcPool` /
 * `request` / `serve` surface until the sdk release that exports the pool is pinned here; then
 * this file goes and the sdk's pool is used instead.
 *
 * What makes it polite, so free nodes never throttle or ban the service's address:
 *
 *   - One node per request. A request walks to the next node only when the node it asked
 *     DECLINED (rate limit, down, range too wide, block not there yet); a real answer, including
 *     a revert, is never retried elsewhere.
 *   - Reads about NOW (the head, `latest`) go to one primary node, so the head never runs
 *     backwards; reads about THEN (a pinned block, a closed log range) rotate across the nodes by
 *     weight, which spreads the load.
 *   - A rate limit (HTTP 429, `-32005` and the other quota codes) cools the node with a growing
 *     backoff and halves the requests it may have in flight; answers regrow that slowly.
 *   - A short read cache and in-flight dedup answer identical reads once.
 *   - `eth_getLogs` goes only to nodes that serve logs at that width, address-less filters only to
 *     nodes that serve those, and a range no node takes whole is split into windows one does.
 *
 * With `ordered`, the nodes are the operator's override (`RPC_URLS` / `RPC_URLS_FILE`): they
 * are asked in the configured order instead of by rotation, with the same refusal handling.
 *
 * No URL ever leaves this module: errors and `describe()` name a node by its position.
 */

import { rpcChainOf, type RpcNode } from "./rpc-nodes";

export type { RpcNode };

/** Methods the pool refuses outright: it reads, it never writes. */
const NEVER_FORWARDED: ReadonlySet<string> = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_sign",
  "eth_signTransaction",
  "personal_sign",
]);

/** Reads about NOW. Anything with a `latest`-ish block tag joins them. */
const NOW_METHODS: ReadonlySet<string> = new Set([
  "eth_blockNumber",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
]);

/** Where each method carries its block tag, for the ones that take one. */
const BLOCK_PARAM: Readonly<Record<string, number>> = {
  eth_call: 1,
  eth_estimateGas: 1,
  eth_getBalance: 1,
  eth_getBlockByNumber: 0,
  eth_getCode: 1,
  eth_getStorageAt: 2,
  eth_getTransactionCount: 1,
};

/** HTTP statuses that are a node declining, not an answer. */
const REFUSED_HTTP: ReadonlySet<number> = new Set([
  401, 403, 408, 410, 413, 425, 429, 500, 502, 503, 504, 521, 525,
]);

/** Rate-limit and quota codes, every one of which has arrived as HTTP 200 somewhere. */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([
  -32005, -32007, -32011, -32012, -32016, -32090,
]);
const RATE_LIMIT =
  /rate limit|too many requests|request limit|cu limit|quota|throttl/i;

/** "This node pruned that": it never arrives, so it is a move-on and not a wait. */
const PRUNED =
  /pruned history|history (?:has been |is )?pruned|earliest available \d|is pruned/i;

/** "Ask with an address": address-less log filters are not served there. */
const NEEDS_ADDRESS = /specify an address/i;

/** A method this node does not serve, or does not serve to anonymous callers. */
const UNSUPPORTED =
  /method (?:not found|not available|is not whitelisted|not supported)|not available for unregistered|not whitelisted/i;

/** "Not yet": a block the node has not reached. Waited on when every member says it. */
export const BLOCK_UNAVAILABLE =
  /block not found|unknown block|header not found|missing trie node/i;
const NOT_YET = new RegExp(
  `${BLOCK_UNAVAILABLE.source}|beyond current head|beyond the latest block`,
  "i",
);

/** A node declining one shape of request (pocket's "archival requests"): walked past, not cooled. */
const DECLINED_HERE = /no archival-capable|archival requests/i;

/** "Your block range was too wide", in every wording the free nodes use. */
export function isRangeTooWide(message: string): boolean {
  return /log response size exceeded|10,?000 block range|query returned more than|block range is too large|exceed(?:s)? max(?:imum)? block range|response size exceeded|too many results|limited to a [\d,]+ range|limited to [\d,]+ blocks?|ranges? over [\d,]+ blocks?|block range too large|bounded block range|too complex|lesser input/i.test(
    message,
  );
}

/** The waits before re-walking when every member says the block is not there yet. */
export const BLOCK_WAIT_MS: readonly number[] = [400, 900, 1800];

type Json = Record<string, unknown>;

export interface RpcCall {
  jsonrpc?: string;
  id?: unknown;
  method: string;
  params?: unknown[];
}

/** What one member said, sorted into the only distinctions routing needs. */
export type Verdict =
  | { kind: "answer" }
  | { kind: "rate-limited" }
  | { kind: "down" }
  | { kind: "range"; cap: number | null }
  | { kind: "needs-address" }
  | { kind: "pruned"; below: number | null }
  | { kind: "not-yet" }
  | { kind: "declined" }
  | { kind: "unsupported" };

/**
 * Sort one member's response. The message is read before the code: `-32001` is "block not
 * found" on one node and "range too large" on another.
 */
export function classify(status: number, body: unknown): Verdict {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)
    ?.error;
  const message = typeof err?.message === "string" ? err.message : "";
  const code = typeof err?.code === "number" ? err.code : null;
  if (message) {
    if (isRangeTooWide(message))
      return { kind: "range", cap: capFrom(message) };
    if (NEEDS_ADDRESS.test(message)) return { kind: "needs-address" };
    if (PRUNED.test(message))
      return { kind: "pruned", below: prunedBelowFrom(message) };
    if (NOT_YET.test(message)) return { kind: "not-yet" };
    if (DECLINED_HERE.test(message)) return { kind: "declined" };
    if (UNSUPPORTED.test(message)) return { kind: "unsupported" };
    if (RATE_LIMIT.test(message)) return { kind: "rate-limited" };
  }
  if (code !== null && RATE_LIMIT_CODES.has(code))
    return { kind: "rate-limited" };
  if (code === -32601) return { kind: "unsupported" };
  if (status === 429) return { kind: "rate-limited" };
  if (status === 0 || REFUSED_HTTP.has(status)) return { kind: "down" };
  if (body === undefined || body === null || typeof body !== "object")
    return { kind: "down" };
  if (!("result" in body) && !("error" in body)) return { kind: "down" };
  return { kind: "answer" };
}

/** The width a range refusal names, when it names one. Never trusted to be the whole truth. */
function capFrom(message: string): number | null {
  const m =
    /limited to a ([\d,]+) range/i.exec(message) ??
    /max(?:imum)? (?:allowed is|block range:?) ?([\d,]+)/i.exec(message) ??
    /limited to ([\d,]+) blocks?/i.exec(message);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function prunedBelowFrom(message: string): number | null {
  const m =
    /earliest available (\d+)/i.exec(message) ??
    /state at block #?(\d+) is pruned/i.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  // "earliest available N" keeps N; "state at block N is pruned" loses N itself.
  return /earliest/i.test(m[0]) ? n : n + 1;
}

/** A block tag as a number, or null for `latest` / `pending` / `safe` / `finalized` / absent. */
function blockNumberOf(tag: unknown): number | null {
  if (typeof tag === "string" && /^0x[0-9a-f]+$/i.test(tag))
    return Number.parseInt(tag, 16);
  if (typeof tag === "number" && Number.isFinite(tag)) return tag;
  if (tag === "earliest") return 0;
  if (tag && typeof tag === "object" && "blockNumber" in (tag as Json)) {
    return blockNumberOf((tag as Json).blockNumber);
  }
  return null;
}

interface LogFilter {
  address?: unknown;
  fromBlock?: unknown;
  toBlock?: unknown;
  blockHash?: unknown;
  topics?: unknown;
}

const hex = (n: number) => `0x${n.toString(16)}`;

/** The block a request names: a log filter's `toBlock`, or the method's block tag. */
function blockOf(method: string, params: unknown[]): number | null {
  if (method === "eth_getLogs")
    return blockNumberOf(((params[0] ?? {}) as LogFilter).toBlock ?? null);
  return BLOCK_PARAM[method] !== undefined
    ? blockNumberOf(params[BLOCK_PARAM[method]])
    : null;
}

/** `Retry-After` as ms from now: delta seconds or an HTTP date. 0 when absent. */
function retryAfterOf(headers: Headers | undefined, now: number): number {
  const value = headers?.get?.("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

// ── the read cache ────────────────────────────────────────────────────────────

/** About one block on Base. */
const FRESH_TTL_MS = 2_000;
/** A closed log range, a mined receipt, deployed code: settled, but not forever (reorgs). */
const SETTLED_TTL_MS = 600_000;
const IMMUTABLE_TTL_MS = 3_600_000;
const MAX_CACHE_ENTRIES = 2_000;

const FRESH_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getStorageAt",
  "eth_maxPriorityFeePerGas",
]);
const SETTLED_METHODS = new Set([
  "eth_getBlockByHash",
  "eth_getCode",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
]);
const IMMUTABLE_METHODS = new Set(["eth_chainId", "net_version"]);
/** A nonce, a gas estimate, a header by number (reorgs) and a pinned call are never cached. */
const NEVER_CACHE = new Set([
  "eth_estimateGas",
  "eth_getTransactionCount",
  "eth_getBlockByNumber",
]);

interface CachePlan {
  key: string;
  ttlMs: number;
  /** An empty answer (`0x` code, `null` receipt, no logs) means "not yet" and is held briefly. */
  emptyIsPending: boolean;
}

function cachePlanFor(method: string, params: unknown[]): CachePlan | null {
  if (NEVER_CACHE.has(method)) return null;
  if (method === "eth_call") {
    const block = params[1];
    if (
      typeof block === "number" ||
      (typeof block === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(block)) ||
      (block !== null && typeof block === "object")
    )
      return null;
  }
  const serialized = JSON.stringify(params);
  if (serialized.includes("pending")) return null;
  const key = `${method}:${serialized}`;
  if (IMMUTABLE_METHODS.has(method))
    return { key, ttlMs: IMMUTABLE_TTL_MS, emptyIsPending: false };
  if (FRESH_METHODS.has(method))
    return { key, ttlMs: FRESH_TTL_MS, emptyIsPending: false };
  if (SETTLED_METHODS.has(method)) {
    const open = /latest|safe|finalized|earliest/.test(serialized);
    return open
      ? { key, ttlMs: FRESH_TTL_MS, emptyIsPending: false }
      : { key, ttlMs: SETTLED_TTL_MS, emptyIsPending: true };
  }
  return null;
}

function ttlFor(plan: CachePlan, result: unknown): number {
  if (!plan.emptyIsPending) return plan.ttlMs;
  const empty =
    result === null ||
    result === undefined ||
    result === "0x" ||
    (Array.isArray(result) && result.length === 0);
  return empty ? FRESH_TTL_MS : plan.ttlMs;
}

// ── the pool ──────────────────────────────────────────────────────────────────

interface Member {
  index: number;
  spec: RpcNode;
  logs: "any" | "addressed" | "none";
  maxLogSpan: number;
  unsupported: Set<string>;
  prunedBelow: number;
  behindUntil: number;
  cooldownUntil: number;
  strikes: number;
  inFlight: number;
  /** How many requests it may have in flight now: halved by a rate limit, regrown by answers. */
  limit: number;
  /** Answers since the limit last grew. */
  streak: number;
}

export interface RpcPoolOptions {
  /** The chain this pool serves. */
  chainId: number | bigint;
  nodes: readonly RpcNode[];
  /** Ask the nodes in the configured order (the operator's override) instead of by rotation. */
  ordered?: boolean;
  /**
   * Answer `eth_chainId` / `net_version` locally. True for the measured free nodes; false for an
   * operator's URLs, where the chain id is the very thing a caller may ask to check them.
   */
  localChainId?: boolean;
  /**
   * Reuse answers: reads about now for about a block, settled facts (closed log windows, mined
   * receipts, deployed code) for ten minutes. `false` turns reuse off; identical reads in flight
   * are still shared.
   */
  cache?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1). Injected so a test can pin the primary and the rotation. */
  random?: () => number;
  /** Per-attempt timeout. `eth_getLogs` gets twice as long. */
  timeoutMs?: number;
  blockWaitMs?: readonly number[];
}

export interface ServeOptions {
  /** Skip a cached answer (the new one is still cached). */
  fresh?: boolean;
  signal?: AbortSignal;
}

/** Requests one member may have in flight. */
const MAX_IN_FLIGHT = 6;
/** Log windows a split request runs at once. */
const SPLIT_CONCURRENCY = 3;
/** The most windows one split may become. Past it the range refusal goes back to the caller. */
const MAX_SPLIT_WINDOWS = 24;
const COOLDOWN_MS = [1_000, 3_000, 10_000, 30_000];
/**
 * The longest a request waits for a member to leave its cooldown when every member that serves it
 * is cooling. A longer cooldown (a `Retry-After` of a minute) refuses the request at once, without a
 * request to any node.
 */
const COOLDOWN_WAIT_MS = 2_000;
/** How long "this node is behind that block" is believed. */
const BEHIND_MS = 3_000;

/** A JSON-RPC error answer, thrown by {@link RpcPool.request}. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcPool {
  readonly chainId: number;
  private readonly members: Member[];
  private readonly ordered: boolean;
  private readonly fetchImpl: (
    url: string,
    init: RequestInit,
  ) => Promise<Response>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly blockWaitMs: readonly number[];
  private readonly localChainId: boolean;
  private readonly caching: boolean;
  private readonly cached = new Map<
    string,
    { result: unknown; expiresAt: number }
  >();
  private readonly inflight = new Map<string, Promise<Json>>();
  private primary: Member | null = null;
  private rotation: number;
  /** The highest head any member has reported, so `eth_blockNumber` never runs backwards. */
  private topHead = 0;

  constructor(opts: RpcPoolOptions) {
    if (opts.nodes.length === 0)
      throw new Error("an RPC pool needs at least one node");
    this.chainId = Number(opts.chainId);
    this.ordered = opts.ordered ?? false;
    this.caching = opts.cache ?? true;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.random = opts.random ?? Math.random;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.blockWaitMs = opts.blockWaitMs ?? BLOCK_WAIT_MS;
    this.localChainId = opts.localChainId ?? !this.ordered;
    this.members = opts.nodes.map((spec, index) => ({
      index,
      spec,
      logs: spec.logs ?? "any",
      maxLogSpan: spec.maxLogSpan ?? Number.POSITIVE_INFINITY,
      unsupported: new Set<string>(),
      prunedBelow: 0,
      behindUntil: 0,
      cooldownUntil: 0,
      strikes: 0,
      inFlight: 0,
      limit: MAX_IN_FLIGHT,
      streak: 0,
    }));
    this.rotation = Math.floor(this.random() * 1_000_000);
  }

  /**
   * One call's result, or a thrown {@link RpcError} carrying the node's code, message and data.
   */
  async request<T = unknown>(
    method: string,
    params: unknown[] = [],
  ): Promise<T> {
    const answer = (await this.serve({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    })) as Json;
    if ("error" in answer) {
      const e = (answer.error ?? {}) as Json;
      throw new RpcError(
        typeof e.code === "number" ? e.code : -32603,
        typeof e.message === "string" ? e.message : "RPC error",
        e.data,
      );
    }
    return answer.result as T;
  }

  /** Serve one JSON-RPC body, a call or a batch. A batch is split and each call routed alone. */
  async serve(body: unknown, opts: ServeOptions = {}): Promise<unknown> {
    if (Array.isArray(body)) {
      if (body.length === 0)
        return envelope(null, {
          error: { code: -32600, message: "Invalid Request" },
        });
      return Promise.all(
        body.map((call) => this.serveOne(call as RpcCall, opts)),
      );
    }
    return this.serveOne(body as RpcCall, opts);
  }

  private async serveOne(call: RpcCall, opts: ServeOptions): Promise<Json> {
    const id = call?.id ?? null;
    if (!call || typeof call.method !== "string") {
      return envelope(id, {
        error: { code: -32600, message: "Invalid Request" },
      });
    }
    const { method } = call;
    const params = Array.isArray(call.params) ? call.params : [];
    if (NEVER_FORWARDED.has(method)) {
      return envelope(id, {
        error: {
          code: -32601,
          message: `${method} is not sent through the read pool`,
        },
      });
    }
    if (this.localChainId && method === "eth_chainId")
      return envelope(id, { result: hex(this.chainId) });
    if (this.localChainId && method === "net_version")
      return envelope(id, { result: String(this.chainId) });

    const plan = cachePlanFor(method, params);
    const reuse = this.caching && plan !== null;
    if (reuse && !opts.fresh) {
      const hit = this.readCached(plan.key);
      if (hit) return envelope(id, { result: hit.result });
    }
    const run = async (): Promise<Json> => {
      const answer = await this.resolve(method, params, opts.signal);
      if (reuse && "result" in answer && !("error" in answer)) {
        this.writeCached(plan.key, answer.result, ttlFor(plan, answer.result));
      }
      return answer;
    };
    // Identical reads in flight share one request; each caller gets its own `id`.
    const answer = plan ? await this.singleFlight(plan.key, run) : await run();
    return envelope(id, answer);
  }

  private readCached(key: string): { result: unknown } | undefined {
    const hit = this.cached.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.cached.delete(key);
      return undefined;
    }
    this.cached.delete(key);
    this.cached.set(key, hit);
    return { result: hit.result };
  }

  private writeCached(key: string, result: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.cached.delete(key);
    this.cached.set(key, { result, expiresAt: this.now() + ttlMs });
    while (this.cached.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cached.keys().next();
      if (oldest.done) break;
      this.cached.delete(oldest.value);
    }
  }

  private singleFlight(key: string, run: () => Promise<Json>): Promise<Json> {
    const running = this.inflight.get(key);
    if (running) return running;
    const started = run().finally(() => {
      if (this.inflight.get(key) === started) this.inflight.delete(key);
    });
    this.inflight.set(key, started);
    return started;
  }

  /** A result or an error object for one call, after the walk, the split and the tip wait. */
  private async resolve(
    method: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<Json> {
    if (method === "eth_getLogs")
      return this.logs((params[0] ?? {}) as LogFilter, signal, 0);
    const answer = await this.walkWaitingForBlock(method, params, signal, null);
    if (method === "eth_blockNumber" && typeof answer.result === "string") {
      // Never backwards: a failover to a member one block behind must not rewind the head.
      const n = Number.parseInt(answer.result, 16);
      if (Number.isFinite(n)) {
        this.topHead = Math.max(this.topHead, n);
        return { result: hex(this.topHead) };
      }
    }
    return answer;
  }

  /**
   * `eth_getLogs`, split when no member takes the range whole. A window that fails fails the
   * whole read: a merged list with a hole would look complete.
   */
  private async logs(
    filter: LogFilter,
    signal: AbortSignal | undefined,
    depth: number,
  ): Promise<Json> {
    if (filter.blockHash !== undefined)
      return this.walkWaitingForBlock("eth_getLogs", [filter], signal, null);
    const from = blockNumberOf(filter.fromBlock ?? "latest");
    const to = blockNumberOf(filter.toBlock ?? "latest");
    const span = from !== null && to !== null ? to - from : null;

    const first = await this.walkWaitingForBlock(
      "eth_getLogs",
      [filter],
      signal,
      span,
    );
    if (!("error" in first) || depth >= 4) return first;
    if (classify(200, first).kind !== "range") return first;

    // Every member that serves this filter declined its width: cut it into windows one takes.
    const lo = from ?? 0;
    const hi = to ?? (await this.head(signal));
    if (hi === null || hi < lo) return first;
    const cap = this.widestLogSpan(filter);
    const width = Math.max(
      1,
      Math.floor(span !== null && cap >= span ? span / 2 : cap),
    );
    if (Math.ceil((hi - lo + 1) / (width + 1)) > MAX_SPLIT_WINDOWS)
      return first;
    const windows: Array<[number, number]> = [];
    for (let start = lo; start <= hi; start += width + 1)
      windows.push([start, Math.min(hi, start + width)]);
    const results: unknown[][] = new Array(windows.length);
    let failure: Json | null = null;
    let next = 0;
    const worker = async () => {
      while (failure === null && next < windows.length) {
        const i = next++;
        const [a, b] = windows[i];
        const part = await this.logs(
          { ...filter, fromBlock: hex(a), toBlock: hex(b) },
          signal,
          depth + 1,
        );
        if ("error" in part || !Array.isArray(part.result)) {
          failure ??= part;
          return;
        }
        results[i] = part.result;
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(SPLIT_CONCURRENCY, windows.length) },
        worker,
      ),
    );
    if (failure) return failure;
    return { result: results.flat() };
  }

  /** The head, for resolving a `latest` bound before a split. */
  private async head(signal?: AbortSignal): Promise<number | null> {
    const answer = await this.resolve("eth_blockNumber", [], signal);
    return typeof answer.result === "string"
      ? Number.parseInt(answer.result, 16)
      : null;
  }

  /** The widest window any member currently serving this filter accepts. */
  widestLogSpan(filter: { address?: unknown } = {}): number {
    const addressed = filter.address !== undefined && filter.address !== null;
    let best = 0;
    for (const m of this.members) {
      if (m.logs === "none" || (m.logs === "addressed" && !addressed)) continue;
      if (m.unsupported.has("eth_getLogs")) continue;
      best = Math.max(best, m.maxLogSpan);
    }
    return best > 0 ? best : 1_000;
  }

  /**
   * One walk of the pool, then, only if every member said the block is not there yet, the tip
   * wait. The block is already mined when a caller names it, so "not yet" stops being true.
   */
  private async walkWaitingForBlock(
    method: string,
    params: unknown[],
    signal: AbortSignal | undefined,
    span: number | null,
  ): Promise<Json> {
    let answer = await this.walk(method, params, signal, span);
    for (const wait of this.blockWaitMs) {
      if (!("error" in answer) || classify(200, answer).kind !== "not-yet")
        break;
      if (signal?.aborted) return answer;
      await this.sleep(wait);
      answer = await this.walk(method, params, signal, span);
    }
    return this.waitOutEveryoneCooling(method, params, signal, span, answer);
  }

  /**
   * One bounded wait when nobody is left to ask: a walk that ends refused with every member that
   * serves the request cooling waits for the first cooldown to end, if that is at most
   * {@link COOLDOWN_WAIT_MS} away, and walks once more.
   */
  private async waitOutEveryoneCooling(
    method: string,
    params: unknown[],
    signal: AbortSignal | undefined,
    span: number | null,
    answer: Json,
  ): Promise<Json> {
    if (!("error" in answer) || signal?.aborted) return answer;
    const wait = this.readyAt(method, params, span) - this.now();
    if (wait <= 0 || wait > COOLDOWN_WAIT_MS) return answer;
    await this.sleep(wait);
    return this.walk(method, params, signal, span);
  }

  /**
   * When the first member that serves this request leaves its cooldown; 0 when one is ready now or
   * none serves it.
   */
  private readyAt(
    method: string,
    params: unknown[],
    span: number | null,
  ): number {
    const t = this.now();
    const ends = this.candidates(method, params, span).map(
      (m) => m.cooldownUntil,
    );
    if (ends.length === 0 || ends.some((end) => end <= t)) return 0;
    return Math.min(...ends);
  }

  /** Ask members in routing order, each at most once, until one answers. */
  private async walk(
    method: string,
    params: unknown[],
    signal: AbortSignal | undefined,
    span: number | null,
  ): Promise<Json> {
    const order = this.order(method, params, span);
    if (order.length === 0) {
      const at = this.readyAt(method, params, span);
      if (at > 0) {
        const seconds = Math.max(1, Math.ceil((at - this.now()) / 1_000));
        return {
          error: {
            code: -32005,
            message: `no RPC node is ready: every node that serves this request is cooling down after a refusal, the first for ${seconds} s more`,
          },
        };
      }
    }
    let last: Json | null = null;
    for (const member of order) {
      if (signal?.aborted) break;
      const { status, body, retryAfterMs } = await this.ask(
        member,
        method,
        params,
        signal,
      );
      const verdict = classify(status, body);
      if (verdict.kind === "answer") {
        this.succeeded(member);
        return strip(body as Json);
      }
      this.learn(member, method, params, verdict, retryAfterMs);
      last =
        body && typeof body === "object" && "error" in (body as Json)
          ? strip(body as Json)
          : {
              error: {
                code: -32603,
                message: `node #${member.index + 1} refused the request (HTTP ${status})`,
              },
            };
    }
    return (
      last ?? {
        error: {
          code: -32603,
          message: "no RPC node in the pool could serve this request",
        },
      }
    );
  }

  private async ask(
    member: Member,
    method: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown; retryAfterMs: number }> {
    while (member.inFlight >= member.limit) await this.sleep(25);
    member.inFlight += 1;
    const timeout = withTimeout(
      signal,
      method === "eth_getLogs" ? this.timeoutMs * 2 : this.timeoutMs,
    );
    try {
      const res = await this.fetchImpl(member.spec.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: timeout,
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return {
        status: res.status,
        body,
        retryAfterMs: retryAfterOf(res.headers, this.now()),
      };
    } catch {
      // A transport error's message can carry the URL; it is never passed on.
      return { status: 0, body: undefined, retryAfterMs: 0 };
    } finally {
      member.inFlight -= 1;
    }
  }

  /**
   * An answer does not forgive a rate limit at once: the backoff decays one step per answer, and
   * the concurrency a rate limit halved grows back by one per ten answers.
   */
  private succeeded(member: Member): void {
    member.strikes = Math.max(0, member.strikes - 1);
    if (member.limit < MAX_IN_FLIGHT && ++member.streak >= 10) {
      member.limit += 1;
      member.streak = 0;
    }
  }

  /** Remember what a refusal says about this member, so the next request is not wasted on it. */
  private learn(
    member: Member,
    method: string,
    params: unknown[],
    verdict: Verdict,
    retryAfterMs = 0,
  ): void {
    const t = this.now();
    switch (verdict.kind) {
      case "rate-limited":
      case "down": {
        const backoff =
          COOLDOWN_MS[Math.min(member.strikes, COOLDOWN_MS.length - 1)];
        member.cooldownUntil = t + Math.max(backoff, retryAfterMs);
        member.strikes += 1;
        if (verdict.kind === "rate-limited") {
          member.limit = Math.max(1, Math.floor(member.limit / 2));
          member.streak = 0;
        }
        if (this.primary === member) this.primary = null;
        return;
      }
      case "range": {
        const filter = (params[0] ?? {}) as LogFilter;
        const from = blockNumberOf(filter.fromBlock ?? null);
        const to = blockNumberOf(filter.toBlock ?? null);
        const asked = from !== null && to !== null ? to - from : null;
        // A named cap is believed only if it is below what was asked.
        const named =
          verdict.cap !== null && (asked === null || verdict.cap < asked)
            ? verdict.cap
            : null;
        const learned =
          named ?? (asked !== null ? Math.floor(asked / 2) : null);
        if (learned !== null)
          member.maxLogSpan = Math.max(1, Math.min(member.maxLogSpan, learned));
        return;
      }
      case "needs-address":
        if (member.logs === "any") member.logs = "addressed";
        return;
      case "pruned":
        member.prunedBelow = Math.max(
          member.prunedBelow,
          verdict.below ?? Number.MAX_SAFE_INTEGER,
        );
        return;
      case "not-yet":
        member.behindUntil = t + BEHIND_MS;
        return;
      case "unsupported":
        member.unsupported.add(method);
        if (method === "eth_getLogs") member.logs = "none";
        return;
      default:
        return;
    }
  }

  /**
   * Who to ask, in order. Members that cannot serve the request or are cooling down are left out;
   * members believed behind go to the back rather than out. Empty when every member that serves the
   * request is cooling: a rate limit is honoured, not walked through.
   */
  private order(
    method: string,
    params: unknown[],
    span: number | null,
  ): Member[] {
    const t = this.now();
    const filter =
      method === "eth_getLogs" ? ((params[0] ?? {}) as LogFilter) : null;
    const pool = this.candidates(method, params, span);
    const ranked = this.ordered
      ? pool
      : this.aboutNow(method, filter, blockOf(method, params))
        ? this.primaryFirst(pool)
        : this.rotated(pool);
    const awake = ranked.filter((m) => m.cooldownUntil <= t);
    const behind = awake
      .filter((m) => m.behindUntil > t)
      .sort((a, b) => a.behindUntil - b.behindUntil);
    return [...awake.filter((m) => m.behindUntil <= t), ...behind];
  }

  /**
   * The members that can serve the request, cooling or not. When none can, everyone who serves the
   * method, so the last refusal is honest.
   */
  private candidates(
    method: string,
    params: unknown[],
    span: number | null,
  ): Member[] {
    const filter =
      method === "eth_getLogs" ? ((params[0] ?? {}) as LogFilter) : null;
    const block = blockOf(method, params);
    const lowest = filter ? blockNumberOf(filter.fromBlock ?? null) : block;
    const addressed = filter
      ? filter.address !== undefined && filter.address !== null
      : false;

    const serves = (m: Member) =>
      !m.unsupported.has(method) && (!filter || m.logs !== "none");
    const able = this.members.filter((m) => {
      if (!serves(m)) return false;
      if (filter) {
        if (m.logs === "addressed" && !addressed) return false;
        if (span !== null && span > m.maxLogSpan) return false;
        if (
          span === null &&
          Number.isFinite(m.maxLogSpan) &&
          filter.blockHash === undefined
        ) {
          const from = blockNumberOf(filter.fromBlock ?? "latest");
          if (
            from !== null &&
            (this.topHead === 0 || this.topHead - from > m.maxLogSpan)
          )
            return false;
        }
      }
      if (lowest !== null && lowest < m.prunedBelow) return false;
      return true;
    });
    return able.length > 0 ? able : this.members.filter(serves);
  }

  /** Is this a read about NOW? A pinned read at the tip counts too. */
  private aboutNow(
    method: string,
    filter: LogFilter | null,
    block: number | null,
  ): boolean {
    if (NOW_METHODS.has(method)) return true;
    const atTip =
      block !== null && this.topHead > 0 && block >= this.topHead - 2;
    if (filter)
      return blockNumberOf(filter.toBlock ?? "latest") === null || atTip;
    if (BLOCK_PARAM[method] === undefined) return false;
    return block === null || atTip;
  }

  private primaryFirst(pool: Member[]): Member[] {
    const t = this.now();
    if (!this.primary || this.primary.cooldownUntil > t) {
      this.primary =
        this.draw(this.members.filter((m) => m.cooldownUntil <= t)) ??
        this.primary;
    }
    const p = this.primary;
    if (!p || !pool.includes(p)) return this.rotated(pool);
    return [p, ...this.rotated(pool.filter((m) => m !== p))];
  }

  /** A weighted draw: the primary, until it refuses. */
  private draw(pool: Member[]): Member | null {
    if (pool.length === 0) return null;
    const total = pool.reduce((s, m) => s + (m.spec.weight ?? 1), 0);
    let x = this.random() * total;
    for (const m of pool) {
      x -= m.spec.weight ?? 1;
      if (x < 0) return m;
    }
    return pool[pool.length - 1];
  }

  /** Weighted round-robin: a member of weight 3 leads three turns in every lap, weight 1 one. */
  private rotated(pool: Member[]): Member[] {
    if (pool.length <= 1) return pool;
    const slots: Member[] = [];
    for (const m of pool)
      for (let i = 0; i < Math.max(1, m.spec.weight ?? 1); i += 1)
        slots.push(m);
    const lead = slots[this.rotation % slots.length];
    this.rotation = (this.rotation + 1) % 1_000_000;
    const rest = pool
      .filter((m) => m !== lead)
      .sort((a, b) => a.inFlight - b.inFlight);
    return [lead, ...rest];
  }

  /** What the pool believes about each member right now. Nodes are named by position, never URL. */
  describe(): Array<{
    node: string;
    logs: string;
    maxLogSpan: number;
    cooling: boolean;
    prunedBelow: number;
    primary: boolean;
    limit: number;
  }> {
    const t = this.now();
    return this.members.map((m) => ({
      node: `#${m.index + 1}`,
      logs: m.logs,
      maxLogSpan: m.maxLogSpan,
      cooling: m.cooldownUntil > t,
      prunedBelow: m.prunedBelow,
      primary: this.primary === m,
      limit: m.limit,
    }));
  }
}

/** The caller's signal plus a per-attempt timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Only `result` or `error` travels, never another request's `id` or a node's extras. */
function strip(body: Json): Json {
  if ("error" in body) {
    const e = (body.error ?? {}) as Json;
    return {
      error: {
        code: e.code ?? -32603,
        message: e.message ?? "RPC error",
        ...(e.data !== undefined ? { data: e.data } : {}),
      },
    };
  }
  return { result: body.result };
}

function envelope(id: unknown, payload: Json): Json {
  return { jsonrpc: "2.0", id: id ?? null, ...payload };
}

/** Options for {@link createRpcPool}: the chain, and optionally the operator's own URLs. */
export type CreateRpcPoolOptions = Omit<
  Partial<RpcPoolOptions>,
  "chainId" | "nodes"
> & {
  chainId: number | bigint;
  /** The operator's URLs. They replace the chain's free nodes and are asked in this order. */
  urls?: readonly string[];
};

/**
 * The pool for a chain: its measured free nodes, or the operator's own `urls` in their place.
 * Throws for a chain with no measured nodes when no `urls` are given.
 */
export function createRpcPool(opts: CreateRpcPoolOptions): RpcPool {
  const { urls, chainId, ...rest } = opts;
  if (urls && urls.length > 0) {
    return new RpcPool({
      ...rest,
      chainId,
      nodes: urls.map((url) => ({ url })),
      ordered: true,
      localChainId: rest.localChainId ?? false,
    });
  }
  const measured = rpcChainOf(chainId);
  if (!measured) {
    throw new Error(
      `no free RPC nodes are measured for chain ${chainId}: set RPC_URLS or RPC_URLS_FILE`,
    );
  }
  return new RpcPool({ ...rest, chainId, nodes: measured.nodes });
}
