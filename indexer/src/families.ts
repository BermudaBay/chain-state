import { EventFragment, Interface, type ParamType } from "ethers";

/** The event families the indexer serves: every log the sdk reads, plus the vault history. */
export const FAMILIES = [
  "commitments",
  "nullifiers",
  "registry",
  "account-policies",
  "withdrawals",
  "vaults",
] as const;
export type Family = (typeof FAMILIES)[number];

/** The contracts whose logs the indexer reads. The modules come from the registry's `modules()`. */
export interface Contracts {
  pool: string;
  registry: string;
  inboundPolicies?: string;
  safeAccounts?: string;
  keyAccounts?: string;
}
type Role = keyof Contracts;

export interface EventSpec {
  family: Family;
  name: string;
  topic0: string;
  emitters: readonly Role[];
  fragment: EventFragment;
}

const TABLE: ReadonlyArray<[Family, readonly Role[], string]> = [
  [
    "commitments",
    ["pool"],
    "event CommitmentInserted(uint32 treeNumber, bytes32 commitment, uint256 leafIndex, bytes encryptedOutput)",
  ],
  [
    "commitments",
    ["pool"],
    "event TreeRotated(uint32 indexed newTreeNumber, bytes32 finalizedRoot)",
  ],
  ["nullifiers", ["pool"], "event NullifierSpent(bytes32 nullifier)"],
  [
    "registry",
    ["registry"],
    "event LeafWritten(uint256 indexed index, uint256 leaf)",
  ],
  [
    "registry",
    ["inboundPolicies"],
    "event ReceiveRecordLinked(uint256 indexed owner, uint256 next)",
  ],
  [
    "registry",
    ["inboundPolicies"],
    "event ReceiveRecordBound(uint256 indexed owner, uint256 indexed accountId, address writer, uint64 index)",
  ],
  [
    "registry",
    ["inboundPolicies"],
    "event InboundRulesSet(uint256 indexed owner, uint64 rules)",
  ],
  [
    "registry",
    ["inboundPolicies"],
    "event SenderRootSet(uint256 indexed owner, uint256 senderRoot)",
  ],
  [
    "registry",
    ["inboundPolicies"],
    "event InboundWriterSet(uint256 indexed owner, address writer)",
  ],
  [
    "account-policies",
    ["safeAccounts", "keyAccounts"],
    "event PolicySealed(uint256 indexed accountId, uint256 root, bytes sealedList)",
  ],
  [
    "withdrawals",
    ["pool"],
    "event WithdrawalRequested(uint256 indexed requestId, address indexed recipient, address indexed token, uint256 amount, uint64 claimableAt, bool unwrap)",
  ],
  [
    "withdrawals",
    ["pool"],
    "event WithdrawalClaimed(uint256 indexed requestId, address indexed recipient, address token, uint256 amount)",
  ],
  [
    "vaults",
    ["pool"],
    "event VaultAccrued(address indexed token, uint256 assets, uint256 shares, uint256 index, uint256 feeSharesMinted)",
  ],
  [
    "vaults",
    ["pool"],
    "event VaultClassUpdated(address indexed token, uint256 shares, uint256 buffer, uint256 venueShares)",
  ],
  [
    "vaults",
    ["pool"],
    "event AutovaultConverted(address indexed token, uint256 idleIn, uint256 sharesOut)",
  ],
  [
    "vaults",
    ["pool"],
    "event FeesSwept(address indexed token, address indexed to, uint256 shares, uint256 assets)",
  ],
];

const iface = new Interface(TABLE.map(([, , signature]) => signature));

export const EVENTS: readonly EventSpec[] = TABLE.map(
  ([family, emitters, signature]) => {
    const fragment = EventFragment.from(signature);
    return {
      family,
      name: fragment.name,
      topic0: fragment.topicHash,
      emitters,
      fragment,
    };
  },
);

/** Every topic0, for the one combined `eth_getLogs` filter. */
export const TOPICS: readonly string[] = EVENTS.map((e) => e.topic0);

const BY_TOPIC = new Map(EVENTS.map((e) => [e.topic0, e]));

/** One decoded log, as stored and served. */
export interface Row {
  block: number;
  tx: number;
  log: number;
  txHash: string;
  address: string;
  family: Family;
  event: string;
  /** The event's fields in declaration order, encoded as the contract's value table says. */
  fields: Record<string, string | boolean>;
}

/** A log as `eth_getLogs` returns it. */
export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionIndex: string;
  logIndex: string;
  transactionHash: string;
  removed?: boolean;
}

/** The emitters' addresses, lowercase, for the log filter. Unwired modules are left out. */
export function addressesOf(contracts: Contracts): string[] {
  return Object.values(contracts)
    .filter((a): a is string => typeof a === "string" && !/^0x0{40}$/i.test(a))
    .map((a) => a.toLowerCase());
}

/**
 * Decode one log into its row, or `null` when it is not one of the families' events from the
 * contract that emits it.
 */
export function decodeLog(log: RpcLog, contracts: Contracts): Row | null {
  if (log.removed)
    throw new Error(`log ${log.blockNumber}:${log.logIndex} was removed`);
  const spec = BY_TOPIC.get(String(log.topics?.[0]).toLowerCase());
  if (!spec) return null;
  const address = log.address.toLowerCase();
  if (!spec.emitters.some((role) => contracts[role]?.toLowerCase() === address))
    return null;
  const values = iface.decodeEventLog(spec.fragment, log.data, log.topics);
  const fields: Record<string, string | boolean> = {};
  spec.fragment.inputs.forEach((input, i) => {
    fields[input.name] = encodeValue(input, values[i]);
  });
  return {
    block: Number(BigInt(log.blockNumber)),
    tx: Number(BigInt(log.transactionIndex)),
    log: Number(BigInt(log.logIndex)),
    txHash: log.transactionHash.toLowerCase(),
    address,
    family: spec.family,
    event: spec.name,
    fields,
  };
}

/** uint / int: decimal string; bytes and bytesN: lowercase hex; address: lowercase; bool: boolean. */
function encodeValue(param: ParamType, value: unknown): string | boolean {
  if (param.type === "bool") return Boolean(value);
  if (/^u?int\d*$/.test(param.type)) return BigInt(value as bigint).toString();
  return String(value).toLowerCase();
}

/** The row as the events endpoint serves it: positions, emitter and event, then the fields. */
export function servedRow(row: Row): Record<string, unknown> {
  return {
    block: row.block,
    tx: row.tx,
    log: row.log,
    txHash: row.txHash,
    address: row.address,
    event: row.event,
    ...row.fields,
  };
}
