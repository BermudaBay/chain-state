import { describe, expect, test } from "bun:test";
import { Interface, getAddress } from "ethers";
import {
  EVENTS,
  FAMILIES,
  TOPICS,
  decodeLog,
  type Contracts,
} from "../src/families";

// The topic0 table of the HTTP contract (README, Families).
const SPEC: Record<string, string> = {
  CommitmentInserted:
    "0x9ec6704d72ffaf22b42f7d68d671092f595a9d146c43149b49fa9d1c507d7cb7",
  TreeRotated:
    "0xfcacdb65302ea4a6d1950120942718358723635f84963314c3a2dc697ae09517",
  NullifierSpent:
    "0x2d8b76eb247945151bd870d531c84c5420f53e3cb9c0ab3b350f46bb09362096",
  LeafWritten:
    "0x298d5b9207de81e84dc4f9dbb01a46344cca48ec6a3571085ac2a5d4c47a260e",
  ReceiveRecordLinked:
    "0x2adf29d3093551752a1e6d93e4d658825f7293a775bac80ea4b2761acf3045b9",
  ReceiveRecordBound:
    "0xda5323c260e1f10380b908f5889f517ddbff8ab43af5737e3d0721097c0cd7b0",
  InboundRulesSet:
    "0x196ff21998d2ebd693436449b6d8760d1ae40bec20370207d12cb57085650ee2",
  SenderRootSet:
    "0xb9a0ad66a8bbb3f5f0f4e8f45604940cb0225d32036c0da3d75fb9a0d5eba660",
  InboundWriterSet:
    "0x082c781b9bf8bdb8fc7e9257113473eaeb1f1bd1cd2c12382430bd6c2f583eee",
  PolicySealed:
    "0xb9bc81d5587f16ab9ca5cb2f7b04637acab674d04b50b6fb2867e96ccc447bb0",
  WithdrawalRequested:
    "0xc386c45dfbac1618692f7527321b7771d9c0ee1aca9051368cd8e59aaee2fda3",
  WithdrawalClaimed:
    "0x6ad26c5e238e7d002799f9a5db07e81ef14e37386ae03496d7a7ef04713e145b",
  VaultAccrued:
    "0x252bd13e54d5f69b32eb5106267a3b0a573d8403e11dad67ad5bd260fbfe6084",
  VaultClassUpdated:
    "0x6c7fd6f6329d43e36161b0bf212635e5785cd431d5ba9be3b5eec751e0d66c5d",
  AutovaultConverted:
    "0xc2476827f937aa13e803890eefd94a3e62015eb22a0239c6c333f8ca76a90860",
  FeesSwept:
    "0x71034416fc7e6846ec3b1a9c7516164b8b5a354165e249b9686129bcf9950e38",
};

const contracts: Contracts = {
  pool: "0x00000000000000000000000000000000000000aa",
  registry: "0x00000000000000000000000000000000000000bb",
  inboundPolicies: "0x00000000000000000000000000000000000000cc",
  safeAccounts: "0x00000000000000000000000000000000000000dd",
  keyAccounts: "0x00000000000000000000000000000000000000ee",
};

function rpcLog(
  address: string,
  signature: string,
  values: unknown[],
  at = { block: 7, tx: 2, log: 5 },
) {
  const iface = new Interface([signature]);
  const fragment = iface.fragments[0] as any;
  const { data, topics } = iface.encodeEventLog(fragment, values);
  return {
    address,
    topics,
    data,
    blockNumber: `0x${at.block.toString(16)}`,
    transactionIndex: `0x${at.tx.toString(16)}`,
    logIndex: `0x${at.log.toString(16)}`,
    transactionHash: `0x${"AB".repeat(32)}`,
    removed: false,
  };
}

describe("the event table", () => {
  test("should carry the sixteen events of the contract, with its topic0s", () => {
    expect(Object.fromEntries(EVENTS.map((e) => [e.name, e.topic0]))).toEqual(
      SPEC,
    );
  });

  test("should filter on every topic0 once", () => {
    expect([...TOPICS].sort()).toEqual(Object.values(SPEC).sort());
  });

  test("should know the six families", () => {
    expect([...FAMILIES]).toEqual([
      "commitments",
      "nullifiers",
      "registry",
      "account-policies",
      "withdrawals",
      "vaults",
    ]);
  });
});

describe("decodeLog", () => {
  test("should decode a commitment into the contract's row", () => {
    const log = rpcLog(
      contracts.pool.toUpperCase().replace("0X", "0x"),
      "event CommitmentInserted(uint32 treeNumber, bytes32 commitment, uint256 leafIndex, bytes encryptedOutput)",
      [1, `0x${"0F".repeat(32)}`, 1783, "0xD8F1"],
    );
    expect(decodeLog(log, contracts)).toEqual({
      block: 7,
      tx: 2,
      log: 5,
      txHash: `0x${"ab".repeat(32)}`,
      address: contracts.pool,
      family: "commitments",
      event: "CommitmentInserted",
      fields: {
        treeNumber: "1",
        commitment: `0x${"0f".repeat(32)}`,
        leafIndex: "1783",
        encryptedOutput: "0xd8f1",
      },
    });
  });

  test("should encode an empty ciphertext as 0x", () => {
    const log = rpcLog(
      contracts.pool,
      "event CommitmentInserted(uint32 treeNumber, bytes32 commitment, uint256 leafIndex, bytes encryptedOutput)",
      [0, `0x${"01".repeat(32)}`, 3, "0x"],
    );
    expect(decodeLog(log, contracts)?.fields.encryptedOutput).toBe("0x");
  });

  test("should decode indexed fields, addresses in lowercase and booleans as booleans", () => {
    const recipient = getAddress("0x00000000000000000000000000000000000000fe");
    const log = rpcLog(
      contracts.pool,
      "event WithdrawalRequested(uint256 indexed requestId, address indexed recipient, address indexed token, uint256 amount, uint64 claimableAt, bool unwrap)",
      [9, recipient, contracts.keyAccounts!, 10n ** 30n, 1791216000, true],
    );
    expect(decodeLog(log, contracts)?.fields).toEqual({
      requestId: "9",
      recipient: recipient.toLowerCase(),
      token: contracts.keyAccounts!,
      amount: (10n ** 30n).toString(),
      claimableAt: "1791216000",
      unwrap: true,
    });
  });

  test("should put both account modules' policies in one family", () => {
    const signature =
      "event PolicySealed(uint256 indexed accountId, uint256 root, bytes sealedList)";
    expect(
      decodeLog(
        rpcLog(contracts.safeAccounts!, signature, [1, 2, "0x01"]),
        contracts,
      )?.family,
    ).toBe("account-policies");
    expect(
      decodeLog(
        rpcLog(contracts.keyAccounts!, signature, [1, 2, "0x01"]),
        contracts,
      )?.family,
    ).toBe("account-policies");
  });

  test("should ignore an event from a contract that does not emit it", () => {
    const log = rpcLog(
      contracts.pool,
      "event LeafWritten(uint256 indexed index, uint256 leaf)",
      [0, 1],
    );
    expect(decodeLog(log, contracts)).toBeNull();
  });

  test("should refuse a removed log", () => {
    const log = {
      ...rpcLog(
        contracts.registry,
        "event LeafWritten(uint256 indexed index, uint256 leaf)",
        [0, 1],
      ),
      removed: true,
    };
    expect(() => decodeLog(log, contracts)).toThrow(/removed/);
  });
});
