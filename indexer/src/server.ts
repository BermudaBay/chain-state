import { FAMILIES, type Contracts, type Family } from "./families";
import type { Health } from "./follower";
import type { Store } from "./store";

export interface AppOptions {
  store: Store;
  follower: { health(): Health; readonly following: Contracts };
  chainId: number;
  pool: string;
  confirmations: number;
  intervalSeconds: number;
}

const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 5_000;
/**
 * Recent page bodies kept, raw and gzipped, so clients bootstrapping at once share one query and
 * one encoding. Bounded by size: a full page of X-Wing ciphertexts runs to megabytes.
 */
const PAGE_CACHE_BYTES = 64 * 1024 * 1024;

const COMMON_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "ETag",
  "cache-control": "no-cache",
  "content-type": "application/json; charset=utf-8",
  vary: "Accept-Encoding",
};

interface Body {
  raw: string;
  gzipped?: Uint8Array;
}

/** A least-recently-used cache of page bodies, bounded by their total size. */
class PageCache {
  private readonly bodies = new Map<string, Body>();

  get(key: string): Body | undefined {
    const body = this.bodies.get(key);
    if (body) {
      this.bodies.delete(key);
      this.bodies.set(key, body);
    }
    return body;
  }

  set(key: string, body: Body): void {
    this.bodies.set(key, body);
    let bytes = 0;
    for (const b of this.bodies.values()) bytes += sizeOf(b);
    for (const [oldest, b] of this.bodies) {
      if (bytes <= PAGE_CACHE_BYTES || oldest === key) break;
      this.bodies.delete(oldest);
      bytes -= sizeOf(b);
    }
  }
}

function sizeOf(body: Body): number {
  return body.raw.length + (body.gzipped?.length ?? 0);
}

/**
 * The HTTP contract (see README): everything under `/chain-state/`, one chain and one pool.
 *
 *   GET /chain-state/refs/heads/main/{chainId}/{pool}/commitment-events.json  the crawler's path
 *   GET /chain-state/v1/{chainId}/{pool}/head                                  what is verified
 *   GET /chain-state/v1/{chainId}/{pool}/events?family=…&from=…[&to=…][&limit=…]
 *   GET /chain-state/health
 *
 * Only rows up to the last verified block are served. Every answer carries a strong ETag and
 * `Cache-Control: no-cache`, so clients always revalidate and a match costs a 304.
 */
export function createApp(opts: AppOptions): {
  fetch(request: Request): Response;
} {
  const { store } = opts;
  const chainId = String(opts.chainId);
  const pool = opts.pool.toLowerCase();
  let snapshot: { key: string; body: Body } | null = null;
  const pages = new PageCache();

  function respond(
    request: Request,
    status: number,
    body: Body | null,
    etag?: string,
  ): Response {
    const headers: Record<string, string> = { ...COMMON_HEADERS };
    if (etag) {
      headers.etag = etag;
      if (matches(request.headers.get("if-none-match"), etag)) {
        return new Response(null, { status: 304, headers });
      }
    }
    if (!body) return new Response(null, { status, headers });
    let payload: string | Uint8Array = body.raw;
    if (/\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "")) {
      body.gzipped ??= Bun.gzipSync(Buffer.from(body.raw));
      payload = body.gzipped;
      headers["content-encoding"] = "gzip";
    }
    return new Response(request.method === "HEAD" ? null : payload, {
      status,
      headers,
    });
  }

  const error = (request: Request, status: number, message: string) =>
    respond(request, status, { raw: JSON.stringify({ error: message }) });

  function compat(request: Request): Response {
    const meta = store.meta;
    if (meta.confirmed < meta.startBlock)
      return error(request, 503, "indexing");
    const key = `${meta.generation}:${meta.confirmed}`;
    if (snapshot?.key !== key) {
      const events = store.snapshotRows(meta.confirmed);
      snapshot = {
        key,
        body: {
          raw: JSON.stringify({ block: String(meta.confirmed), events }),
        },
      };
    }
    return respond(request, 200, snapshot.body, `"${key}"`);
  }

  function head(request: Request): Response {
    const meta = store.meta;
    const contracts = meta.contracts ?? opts.follower.following;
    const body = {
      chainId,
      generation: meta.generation,
      startBlock: meta.startBlock,
      head: meta.head,
      confirmed: meta.confirmed,
      confirmations: opts.confirmations,
      intervalSeconds: opts.intervalSeconds,
      verifiedAt: meta.verifiedAt,
      contracts: {
        pool: contracts.pool,
        registry: contracts.registry,
        inboundPolicies: contracts.inboundPolicies ?? null,
        safeAccounts: contracts.safeAccounts ?? null,
        keyAccounts: contracts.keyAccounts ?? null,
      },
      roots: meta.roots,
      families: meta.families ?? store.counts(meta.confirmed),
    };
    return respond(
      request,
      200,
      { raw: JSON.stringify(body) },
      `"${meta.generation}:${meta.confirmed}"`,
    );
  }

  function events(request: Request, query: URLSearchParams): Response {
    const family = query.get("family");
    if (!family) return error(request, 400, "missing family");
    if (!(FAMILIES as readonly string[]).includes(family)) {
      return error(request, 400, `unknown family ${family}`);
    }
    const from = blockParam(query.get("from"));
    if (from === undefined)
      return error(request, 400, "from must be a decimal block number");
    const rawTo = query.get("to");
    const to = rawTo === null ? null : blockParam(rawTo);
    if (to === undefined)
      return error(request, 400, "to must be a decimal block number");
    if (to !== null && to < from)
      return error(request, 400, "to must not be below from");
    const rawLimit = query.get("limit");
    const limit = rawLimit === null ? DEFAULT_LIMIT : blockParam(rawLimit);
    if (limit === undefined || limit === 0) {
      return error(request, 400, "limit must be a positive decimal number");
    }

    const meta = store.meta;
    const bound = Math.min(to ?? meta.confirmed, meta.confirmed);
    const page =
      from > bound
        ? { rows: [], to: from - 1, next: null }
        : store.page(family as Family, from, bound, Math.min(limit, MAX_LIMIT));
    const etag = `"${meta.generation}:${family}:${from}:${page.to}"`;
    const key = `${etag}|${meta.confirmed}`;
    let body = pages.get(key);
    if (!body) {
      body = {
        raw:
          `{"family":${JSON.stringify(family)},"generation":${JSON.stringify(meta.generation)},` +
          `"from":${from},"to":${page.to},"next":${page.next},"confirmed":${meta.confirmed},` +
          `"events":[${page.rows.join(",")}]}`,
      };
      pages.set(key, body);
    }
    return respond(request, 200, body, etag);
  }

  function health(request: Request): Response {
    const h = opts.follower.health();
    const raw = JSON.stringify(h);
    return respond(
      request,
      h.ok ? 200 : 503,
      { raw },
      `"${Bun.hash(raw).toString(16)}"`,
    );
  }

  return {
    fetch(request: Request): Response {
      const method = request.method;
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, HEAD, OPTIONS",
            "access-control-allow-headers": "If-None-Match",
            "access-control-max-age": "86400",
          },
        });
      }
      if (method !== "GET" && method !== "HEAD") {
        const res = error(request, 405, "method not allowed");
        res.headers.set("allow", "GET, HEAD, OPTIONS");
        return res;
      }
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "");
      if (path === "/chain-state/health") return health(request);

      const compatPath =
        /^\/chain-state\/refs\/heads\/main\/(\d+)\/(0x[0-9a-fA-F]{40})\/commitment-events\.json$/.exec(
          path,
        );
      const v1Path =
        /^\/chain-state\/v1\/(\d+)\/(0x[0-9a-fA-F]{40})\/(head|events)$/.exec(
          path,
        );
      const route = compatPath ?? v1Path;
      if (!route || route[1] !== chainId || route[2].toLowerCase() !== pool) {
        return error(request, 404, "not found");
      }
      if (compatPath) return compat(request);
      return v1Path![3] === "head"
        ? head(request)
        : events(request, url.searchParams);
    },
  };
}

/** A decimal integer below 2^53, or `undefined`. */
function blockParam(value: string | null): number | undefined {
  if (value === null || !/^\d{1,16}$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Whether an `If-None-Match` header names this ETag (weak comparison, `*` included). */
function matches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === "*" || tag === etag);
}
