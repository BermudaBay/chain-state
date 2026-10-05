import { addressesOf, decodeLog, type Contracts, type Row } from "./families";
import { readHead, readLogs, readModules, readRoots, type Rpc } from "./reads";
import { isRangeTooWide } from "./rpc-pool";
import { redactRpcUrls } from "./rpc-urls";
import type { Store } from "./store";
import { ChainTrees } from "./trees";

/** Ticks in a row whose roots did not match before the database is rebuilt. */
const MISMATCHES_BEFORE_REBUILD = 3;
/** The widest block range one log query asks for. */
const DEFAULT_CHUNK_BLOCKS = 10_000;

export interface FollowerOptions {
  store: Store;
  rpc: Rpc;
  chainId: number;
  /** The pool and the registry core. The modules are read from the core's `modules()`. */
  contracts: Pick<Contracts, "pool" | "registry">;
  multicall?: string;
  /** The pool's commitment tree height (`merkleTreeHeight`). */
  height: number;
  confirmations: number;
  intervalSeconds: number;
  chunkBlocks?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Health {
  ok: boolean;
  chainId: string;
  head: number | null;
  confirmed: number;
  verifiedAt: number | null;
  generation: string;
  reason?:
    | "indexing"
    | "stale"
    | "root mismatch"
    | "start block after registry deployment";
}

/** Rows that cannot be applied to the trees (a leaf twice): handled like a root mismatch. */
class InconsistentRows extends Error {}

/**
 * Follows the chain: every tick it reads the head, fetches the logs of the blocks that are new
 * and at least `confirmations` deep, stores them, and verifies the rebuilt trees against the
 * pool's and the registry's on-chain roots at that block. Only verified rows are served.
 *
 * A mismatch rolls the unverified rows back and retries on the next tick; three in a row (a reorg
 * deeper than the confirmation depth, or a node serving bad data throughout) wipe the database and
 * rebuild it from the start block under a new generation. A head below the indexed block is a
 * node that lags (the pool keeps the head from running backwards only once it has seen one), not a
 * mismatch: the tick waits for it.
 */
export class Follower {
  private readonly store: Store;
  private readonly rpc: Rpc;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxChunk: number;
  private contracts: Contracts;
  private trees: ChainTrees;
  private chunk: number;
  private mismatches = 0;
  private rebuilding = false;
  private sentinelMissing = false;
  private syncedAt: number | null;
  private lastHead: number | null = null;
  /** Whether the last head read was below the indexed block, so the wait is logged once. */
  private headBehind = false;
  private ticking: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Set by `stop()`: the loop schedules no tick, and a running tick ends after its window. */
  private stopping = false;

  constructor(private readonly opts: FollowerOptions) {
    this.store = opts.store;
    this.rpc = opts.rpc;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.maxChunk = opts.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS;
    this.chunk = this.maxChunk;
    this.contracts = {
      ...opts.contracts,
      ...(this.store.meta.contracts ?? {}),
    };
    this.syncedAt =
      this.store.meta.verifiedAt === null
        ? null
        : this.store.meta.verifiedAt * 1000;
    try {
      this.trees = this.loadTrees();
    } catch (error) {
      this.log(
        `the stored rows do not form a tree (${message(error)}); rebuilding`,
      );
      this.store.wipe();
      this.trees = new ChainTrees(opts.height);
    }
  }

  /** The contracts being followed, modules included once the registry has wired them. */
  get following(): Contracts {
    return this.contracts;
  }

  start(): void {
    this.stopping = false;
    const loop = async () => {
      if (this.stopping) return;
      await this.tick();
      if (!this.stopping)
        this.timer = setTimeout(loop, this.opts.intervalSeconds * 1000);
    };
    void loop();
  }

  /** Stop following. A rebuild in progress keeps the windows it stored and resumes on restart. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.ticking;
  }

  /** One tick. Never throws: a failure is logged and the next tick tries again. */
  tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  health(now = this.now()): Health {
    const meta = this.store.meta;
    const body = {
      chainId: String(this.opts.chainId),
      head: this.lastHead ?? meta.head,
      confirmed: meta.confirmed,
      verifiedAt: meta.verifiedAt,
      generation: meta.generation,
    };
    let reason: Health["reason"];
    if (this.sentinelMissing) reason = "start block after registry deployment";
    else if (this.rebuilding) reason = "root mismatch";
    else if (meta.confirmed < meta.startBlock) reason = "indexing";
    else if (
      this.syncedAt === null ||
      now - this.syncedAt >= 3 * this.opts.intervalSeconds * 1000
    )
      reason = "stale";
    return reason ? { ok: false, ...body, reason } : { ok: true, ...body };
  }

  private async runTick(): Promise<void> {
    try {
      await this.discoverModules();
      const head = await readHead(this.rpc);
      if (this.store.meta.indexed > head) {
        if (!this.headBehind) {
          this.log(
            `the head read, ${head}, is below indexed block ${this.store.meta.indexed}; waiting for the node to catch up`,
          );
        }
        this.headBehind = true;
        return;
      }
      this.headBehind = false;
      this.lastHead = head;
      const target = head - this.opts.confirmations;
      if (target > this.store.meta.indexed)
        await this.follow(this.store.meta.indexed + 1, target);
      if (this.stopping) return;
      if (this.store.meta.indexed > this.store.meta.confirmed) {
        await this.verify(this.store.meta.indexed, head);
      }
      if (this.store.meta.indexed === this.store.meta.confirmed)
        this.syncedAt = this.now();
    } catch (error) {
      if (error instanceof InconsistentRows) this.mismatch(error.message);
      else this.log(`tick failed: ${message(error)}`);
    }
  }

  /** Read the registry's modules until it has wired them; a late wiring rebuilds the database. */
  private async discoverModules(): Promise<void> {
    if (this.contracts.inboundPolicies) return;
    const modules = await readModules(this.rpc, this.contracts.registry);
    if (!modules) return;
    this.contracts = { ...this.contracts, ...modules };
    if (this.store.meta.indexed >= this.store.meta.startBlock) {
      this.log(
        "the registry wired its modules after indexing began; rebuilding",
      );
      this.wipe();
    }
    this.store.setContracts(this.contracts);
  }

  /** Fetch, store and apply the logs of blocks `[from, to]`, one window per query. */
  private async follow(from: number, to: number): Promise<void> {
    const addresses = addressesOf(this.contracts);
    let start = from;
    while (start <= to && !this.stopping) {
      const widest = this.rpc.widestLogSpan?.({ address: addresses });
      const blocks = Math.min(
        this.chunk,
        widest === undefined ? Infinity : widest + 1,
      );
      const end = Math.min(to, start + blocks - 1);
      let logs;
      try {
        logs = await readLogs(this.rpc, addresses, start, end);
      } catch (error) {
        if (end > start && isRangeTooWide(message(error))) {
          this.chunk = Math.max(1, Math.floor((end - start + 1) / 2));
          continue;
        }
        throw error;
      }
      const rows = logs
        .map((log) => decodeLog(log, this.contracts))
        .filter((row): row is Row => row !== null);
      this.store.append(rows, end);
      this.apply(rows);
      this.chunk = Math.min(this.maxChunk, this.chunk * 2);
      start = end + 1;
    }
  }

  private apply(rows: readonly Row[]): void {
    try {
      this.trees.addCommitments(
        rows
          .filter((r) => r.event === "CommitmentInserted")
          .map((r) => ({
            treeNumber: Number(r.fields.treeNumber),
            leafIndex: Number(r.fields.leafIndex),
            commitment: String(r.fields.commitment),
          })),
      );
      this.trees.addRegistryLeaves(
        rows
          .filter((r) => r.event === "LeafWritten")
          .map((r) => ({
            index: Number(r.fields.index),
            leaf: String(r.fields.leaf),
          })),
      );
    } catch (error) {
      throw new InconsistentRows(message(error));
    }
  }

  /** Check the trees against the chain at `block`; confirm the rows or roll them back. */
  private async verify(block: number, head: number): Promise<void> {
    if (!this.store.hasSentinel()) {
      if (!this.sentinelMissing) {
        this.log(
          `no LeafWritten at index 0 since block ${this.store.meta.startBlock}: ` +
            "the start block must not be later than the registry's deployment",
        );
      }
      this.sentinelMissing = true;
      return;
    }
    this.sentinelMissing = false;
    const chain = await readRoots(
      this.rpc,
      {
        pool: this.contracts.pool,
        registry: this.contracts.registry,
        multicall: this.opts.multicall,
      },
      block,
    );
    const trees = this.trees;
    const problems: string[] = [];
    if (chain.lastRoot !== trees.activeRoot)
      problems.push(
        `commitment root ${hex32(chain.lastRoot)} on chain, ${hex32(trees.activeRoot)} indexed`,
      );
    if (chain.treeNumber !== trees.activeTreeNumber)
      problems.push(
        `tree ${chain.treeNumber} on chain, ${trees.activeTreeNumber} indexed`,
      );
    if (chain.nextIndex !== trees.nextIndex)
      problems.push(
        `next index ${chain.nextIndex} on chain, ${trees.nextIndex} indexed`,
      );
    if (chain.liveRoot !== trees.registryRoot)
      problems.push(
        `registry root ${hex32(chain.liveRoot)} on chain, ${hex32(trees.registryRoot)} indexed`,
      );
    for (const { newTreeNumber, finalizedRoot } of this.store.rotations(
      this.store.meta.confirmed,
      block,
    )) {
      const indexed = trees.treeRoot(newTreeNumber - 1);
      if (BigInt(finalizedRoot) !== indexed)
        problems.push(
          `tree ${newTreeNumber - 1} finalized at ${finalizedRoot}, ${hex32(indexed)} indexed`,
        );
    }
    if (problems.length > 0) {
      this.mismatch(`at block ${block}: ${problems.join("; ")}`);
      return;
    }
    const from = this.store.meta.confirmed + 1;
    this.store.confirm({
      confirmed: block,
      head,
      verifiedAt: Math.floor(this.now() / 1000),
      contracts: this.contracts,
      roots: {
        commitments: {
          treeNumber: String(chain.treeNumber),
          nextIndex: String(chain.nextIndex),
          root: hex32(chain.lastRoot),
        },
        registry: {
          liveRoot: hex32(chain.liveRoot),
          nextIndex: String(chain.registryNextIndex),
        },
      },
    });
    this.mismatches = 0;
    this.rebuilding = false;
    this.log(`verified blocks ${from}..${block}`);
  }

  private mismatch(reason: string): void {
    this.mismatches += 1;
    this.log(
      `root mismatch (${this.mismatches}/${MISMATCHES_BEFORE_REBUILD}) ${reason}`,
    );
    if (this.mismatches >= MISMATCHES_BEFORE_REBUILD) {
      this.log("rebuilding from the start block under a new generation");
      this.wipe();
      this.rebuilding = true;
      return;
    }
    this.store.rollback(this.store.meta.confirmed);
    this.trees = this.loadTrees();
  }

  private wipe(): void {
    this.store.wipe();
    this.store.setContracts(this.contracts);
    this.trees = new ChainTrees(this.opts.height);
    this.mismatches = 0;
  }

  private loadTrees(): ChainTrees {
    const upTo = this.store.meta.indexed;
    const trees = new ChainTrees(this.opts.height);
    trees.addCommitments(this.store.commitmentLeaves(upTo));
    trees.addRegistryLeaves(this.store.registryLeaves(upTo));
    return trees;
  }
}

function hex32(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function message(error: unknown): string {
  return redactRpcUrls(error instanceof Error ? error.message : String(error));
}
