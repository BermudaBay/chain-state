import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  FAMILIES,
  servedRow,
  type Contracts,
  type Family,
  type Row,
} from "./families";

/** The layout of `events` and `meta`. A database written with another one is rebuilt. */
const SCHEMA = 1;

/** The deployment a database belongs to. A database opened for another one is rebuilt. */
export interface Identity {
  chainId: string;
  pool: string;
  registry: string;
  startBlock: number;
}

/** The on-chain values at `confirmed`, as the indexer read and matched them. */
export interface Roots {
  commitments: { treeNumber: string; nextIndex: string; root: string };
  registry: { liveRoot: string; nextIndex: string };
}

export interface Meta {
  /** A random id, new whenever the database is created, wiped or rebuilt. */
  generation: string;
  startBlock: number;
  /** Every row in blocks `<= indexed` is stored; rows above `confirmed` are not verified yet. */
  indexed: number;
  /** The highest block whose rows are stored and whose roots matched the chain. */
  confirmed: number;
  /** Unix seconds of the verification that set `confirmed`. */
  verifiedAt: number | null;
  /** The chain tip at that verification. */
  head: number | null;
  contracts: Contracts | null;
  roots: Roots | null;
  families: Record<Family, number> | null;
}

export interface CommitmentLeaf {
  treeNumber: number;
  leafIndex: number;
  commitment: string;
}

export interface Page {
  /** The rows, each already serialized as served. */
  rows: string[];
  /** The last block the page covers. */
  to: number;
  /** `to + 1` while `to` is below the requested bound, else `null`. */
  next: number | null;
}

/**
 * The indexer's sqlite database. It is a cache: everything in it can be rebuilt from the chain,
 * so a database that is missing, belongs to another deployment or failed verification is simply
 * wiped and started again under a new generation.
 *
 * `events` holds one row per log, keyed by `(block, log)`, with the served JSON precomputed so a
 * page is spliced together without parsing. Commitments, registry leaves and tree rotations also
 * carry their tree inputs in their own columns, so rebuilding the trees reads no ciphertext.
 */
export class Store {
  private constructor(
    private readonly db: Database,
    private readonly identity: Identity,
    private current: Meta,
  ) {}

  static open(path: string, identity: Identity): Store {
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        block INTEGER NOT NULL,
        log INTEGER NOT NULL,
        tx INTEGER NOT NULL,
        family TEXT NOT NULL,
        event TEXT NOT NULL,
        tree_number INTEGER,
        position INTEGER,
        value TEXT,
        row TEXT NOT NULL,
        PRIMARY KEY (block, log)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS events_by_family ON events (family, block, log);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    `);
    const stored = Object.fromEntries(
      db
        .query<{ key: string; value: string }, []>(
          "SELECT key, value FROM meta",
        )
        .all()
        .map(({ key, value }) => [key, JSON.parse(value)]),
    );
    const store = new Store(db, identity, stored.meta as Meta);
    if (
      !stored.meta ||
      JSON.stringify(stored.identity) !==
        JSON.stringify({ schema: SCHEMA, ...identity })
    ) {
      store.wipe();
    }
    return store;
  }

  get meta(): Meta {
    return this.current;
  }

  close(): void {
    this.db.close();
  }

  /** Store a range's rows and move `indexed` to the range's end, in one transaction. */
  append(rows: readonly Row[], indexed: number): void {
    const insert = this.db.query(
      `INSERT OR REPLACE INTO events (block, log, tx, family, event, tree_number, position, value, row)
       VALUES ($block, $log, $tx, $family, $event, $treeNumber, $position, $value, $row)`,
    );
    this.db.transaction(() => {
      for (const row of rows) insert.run(columnsOf(row));
      this.write({ ...this.current, indexed });
    })();
  }

  /** Drop every row above `block` and move `indexed` back to it. */
  rollback(block: number): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM events WHERE block > ?").run(block);
      this.write({ ...this.current, indexed: block });
    })();
  }

  /** Record a verification: the rows up to `confirmed` matched the chain. */
  confirm(args: {
    confirmed: number;
    head: number;
    verifiedAt: number;
    roots: Roots | null;
    contracts: Contracts;
  }): void {
    this.write({
      ...this.current,
      ...args,
      families: this.counts(args.confirmed),
    });
  }

  /** Remember the contracts being followed (the modules are discovered at runtime). */
  setContracts(contracts: Contracts): void {
    this.write({ ...this.current, contracts });
  }

  /** Drop everything and start a new generation from the start block. */
  wipe(): void {
    const below = this.identity.startBlock - 1;
    this.db.transaction(() => {
      this.db.exec("DELETE FROM events; DELETE FROM meta");
      this.db
        .query("INSERT INTO meta (key, value) VALUES ('identity', ?)")
        .run(JSON.stringify({ schema: SCHEMA, ...this.identity }));
      this.write({
        generation: randomBytes(8).toString("hex"),
        startBlock: this.identity.startBlock,
        indexed: below,
        confirmed: below,
        verifiedAt: null,
        head: null,
        contracts: null,
        roots: null,
        families: null,
      });
    })();
  }

  counts(upTo: number): Record<Family, number> {
    const counts = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<
      Family,
      number
    >;
    for (const { family, n } of this.db
      .query<
        { family: Family; n: number },
        [number]
      >("SELECT family, COUNT(*) AS n FROM events WHERE block <= ? GROUP BY family")
      .all(upTo)) {
      counts[family] = n;
    }
    return counts;
  }

  /** Every commitment up to a block, in chain order. */
  commitmentLeaves(upTo: number): CommitmentLeaf[] {
    return this.db
      .query<CommitmentLeaf, [number]>(
        `SELECT tree_number AS treeNumber, position AS leafIndex, value AS commitment FROM events
         WHERE family = 'commitments' AND event = 'CommitmentInserted' AND block <= ?
         ORDER BY block, log`,
      )
      .all(upTo);
  }

  /** Every registry leaf written up to a block, in chain order. */
  registryLeaves(upTo: number): Array<{ index: number; leaf: string }> {
    return this.db
      .query<{ index: number; leaf: string }, [number]>(
        `SELECT position AS "index", value AS leaf FROM events
         WHERE family = 'registry' AND event = 'LeafWritten' AND block <= ? ORDER BY block, log`,
      )
      .all(upTo);
  }

  /** The tree rotations in blocks `(after, upTo]`. */
  rotations(
    after: number,
    upTo: number,
  ): Array<{ newTreeNumber: number; finalizedRoot: string }> {
    return this.db
      .query<
        { newTreeNumber: number; finalizedRoot: string },
        [number, number]
      >(
        `SELECT tree_number AS newTreeNumber, value AS finalizedRoot FROM events
         WHERE family = 'commitments' AND event = 'TreeRotated' AND block > ? AND block <= ?
         ORDER BY block, log`,
      )
      .all(after, upTo);
  }

  /** Whether the registry's constructor leaf (index 0) is stored. */
  hasSentinel(): boolean {
    return (
      this.db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM events
           WHERE family = 'registry' AND event = 'LeafWritten' AND position = 0`,
        )
        .get()!.n > 0
    );
  }

  /** The compatibility snapshot's rows up to a block, ordered by tree and leaf index. */
  snapshotRows(upTo: number): Array<{
    commitment: string;
    index: string;
    encryptedOutput: string;
    treeNumber: string;
  }> {
    return this.db
      .query<{ row: string }, [number]>(
        `SELECT row FROM events
         WHERE family = 'commitments' AND event = 'CommitmentInserted' AND block <= ?
         ORDER BY tree_number, position`,
      )
      .all(upTo)
      .map(({ row }) => {
        const r = JSON.parse(row);
        return {
          commitment: r.commitment,
          index: r.leafIndex,
          encryptedOutput: r.encryptedOutput,
          treeNumber: r.treeNumber,
        };
      });
  }

  /**
   * One page of a family in blocks `[from, to]`, at most about `limit` rows. A page ends on a
   * block boundary; a first block with more rows than `limit` is still returned whole.
   */
  page(family: Family, from: number, to: number, limit: number): Page {
    const found = this.db
      .query<{ block: number; row: string }, [Family, number, number, number]>(
        `SELECT block, row FROM events WHERE family = ? AND block >= ? AND block <= ?
         ORDER BY block, log LIMIT ?`,
      )
      .all(family, from, to, limit + 1);
    if (found.length <= limit) {
      return { rows: found.map((r) => r.row), to, next: null };
    }
    const last = found[limit - 1].block;
    if (found[limit].block !== last) {
      return {
        rows: found.slice(0, limit).map((r) => r.row),
        to: last,
        next: last + 1,
      };
    }
    // The limit falls inside a block: end before it, or return it whole if it is the first.
    if (found[0].block !== last) {
      const rows = found.filter((r) => r.block < last).map((r) => r.row);
      return { rows, to: last - 1, next: last };
    }
    const whole = this.db
      .query<{ row: string }, [Family, number]>(
        "SELECT row FROM events WHERE family = ? AND block = ? ORDER BY log",
      )
      .all(family, last)
      .map((r) => r.row);
    return { rows: whole, to: last, next: last < to ? last + 1 : null };
  }

  private write(meta: Meta): void {
    this.db
      .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('meta', ?)")
      .run(JSON.stringify(meta));
    this.current = meta;
  }
}

function columnsOf(row: Row) {
  const f = row.fields;
  let treeNumber: number | null = null;
  let position: number | null = null;
  let value: string | null = null;
  if (row.event === "CommitmentInserted") {
    treeNumber = Number(f.treeNumber);
    position = Number(f.leafIndex);
    value = String(f.commitment);
  } else if (row.event === "TreeRotated") {
    treeNumber = Number(f.newTreeNumber);
    value = String(f.finalizedRoot);
  } else if (row.event === "LeafWritten") {
    position = Number(f.index);
    value = String(f.leaf);
  }
  return {
    block: row.block,
    log: row.log,
    tx: row.tx,
    family: row.family,
    event: row.event,
    treeNumber,
    position,
    value,
    row: JSON.stringify(servedRow(row)),
  };
}
