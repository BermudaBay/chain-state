/**
 * The one RPC override, the same in every Bermuda service, and keeping keyed URLs out of
 * everything else. Mirrors the sdk's `rpc-urls.ts`, so the indexer reads the variables exactly as
 * the other services do; it goes when the sdk release that exports it is pinned here.
 *
 * - `RPC_URLS`: an ordered list (commas, spaces or newlines). It must carry no keyed URL, because
 *   environment variables end up in compose files, process listings and logs.
 * - `RPC_URLS_FILE`: the path of a secret file holding the list, one or more URLs per line, `#`
 *   starting a comment. The only place a keyed URL may come from.
 *
 * When set, the list REPLACES the free nodes. Neither has a default. A URL is never logged whole:
 * {@link redactRpcUrl} keeps its scheme and host and drops the path, query and userinfo.
 */

/** The keyed-URL shapes a shipped file must never contain. */
export const KEYED_RPC_URL_PATTERNS: readonly RegExp[] = Object.freeze([
  /alchemy\.com\/v2\//i,
  /infura\.io\/v3\//i,
  /quiknode\.pro\//i,
  /[?&]dkey=/i,
]);

/** A query parameter named like a credential. */
const SECRET_PARAM =
  /[?&](?:api[-_]?key|key|token|access[-_]?token|secret|dkey)=/i;

/** A path segment shaped like a key: long, and mixing letters and digits. */
function looksLikeKey(segment: string): boolean {
  return (
    /^[A-Za-z0-9_-]{20,}$/.test(segment) &&
    /[0-9]/.test(segment) &&
    /[A-Za-z]/.test(segment)
  );
}

/** Whether a URL carries a credential: a known keyed shape, userinfo, a key parameter or path. */
export function isKeyedRpcUrl(url: string): boolean {
  if (KEYED_RPC_URL_PATTERNS.some((p) => p.test(url))) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return true;
  if (SECRET_PARAM.test(parsed.search)) return true;
  return parsed.pathname.split("/").some(looksLikeKey);
}

/** A URL as it may appear in a log or an error: scheme and host, nothing that can hold a key. */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const rest =
      (parsed.pathname && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash;
    return `${parsed.protocol}//${parsed.host}${rest ? "/…" : ""}`;
  } catch {
    return "<invalid url>";
  }
}

/** `text` with every URL in it redacted, for error messages that may quote one. */
export function redactRpcUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>`]+/g, (match) =>
    redactRpcUrl(match),
  );
}

/** The URLs in a list, in order; `#` starts a comment that runs to the end of its line. */
function parseList(text: string, source: string): string[] {
  const urls = text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .flatMap((line) => line.split(/[\s,]+/))
    .filter(Boolean);
  urls.forEach((url, i) => {
    let ok = false;
    try {
      ok = /^https?:$/.test(new URL(url).protocol);
    } catch {}
    if (!ok) throw new Error(`${source} entry ${i + 1} is not an http(s) URL`);
  });
  return urls;
}

/**
 * The RPC URLs a service was configured with, or undefined when it was configured with none
 * (then the free nodes serve it).
 */
export function readRpcUrls(opts: {
  env: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}): string[] | undefined {
  const listed = opts.env.RPC_URLS?.trim();
  const file = opts.env.RPC_URLS_FILE?.trim();
  if (listed && file)
    throw new Error("set RPC_URLS or RPC_URLS_FILE, not both");
  if (file) {
    if (!opts.readFile)
      throw new Error(
        "RPC_URLS_FILE is set, but no readFile was given to read it",
      );
    const urls = parseList(opts.readFile(file), "RPC_URLS_FILE");
    if (urls.length === 0) throw new Error("RPC_URLS_FILE holds no URL");
    return urls;
  }
  if (!listed) return undefined;
  const urls = parseList(listed, "RPC_URLS");
  const keyed = urls.findIndex(isKeyedRpcUrl);
  if (keyed >= 0) {
    throw new Error(
      `RPC_URLS entry ${keyed + 1} (${redactRpcUrl(urls[keyed])}) carries a key; ` +
        "keyed URLs belong in the secret file RPC_URLS_FILE names",
    );
  }
  return urls;
}

/** The RPC variables no service reads any more: `RPC_URLS` and `RPC_URLS_FILE` replace them. */
const RETIRED_RPC_VARIABLES = [
  "RPC",
  "RPC_POOL",
  "FALLBACK_RPCS",
  "BASE_RPC",
  "RPC_UPSTREAM",
];

/**
 * The retired RPC variables set in `env`, by name, a per-chain `RPC_URLS_<CHAIN>` included. Every
 * service ignores them and says so once at boot ({@link retiredRpcWarning}).
 */
export function retiredRpcVariables(
  env: Record<string, string | undefined>,
): string[] {
  const set = (name: string) => Boolean(env[name]?.trim());
  const perChain = Object.keys(env)
    .filter(
      (name) => /^RPC_URLS_[A-Z0-9_]+$/.test(name) && name !== "RPC_URLS_FILE",
    )
    .sort();
  return [...RETIRED_RPC_VARIABLES, ...perChain].filter(set);
}

/** The boot warning for the retired RPC variables set in `env`, by name only; none, undefined. */
export function retiredRpcWarning(
  env: Record<string, string | undefined>,
): string | undefined {
  const names = retiredRpcVariables(env);
  if (names.length === 0) return undefined;
  return (
    `${names.join(", ")} ${names.length === 1 ? "is" : "are"} retired and ignored: ` +
    "set RPC_URLS, or RPC_URLS_FILE for a keyed URL, to replace the free RPC nodes"
  );
}
