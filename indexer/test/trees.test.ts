import { describe, expect, test } from "bun:test";
import { RegistryTree } from "@bermuda/sdk";
import { LeanMerkleTree, poseidon2 } from "@bermuda/sdk/internal";
import { ChainTrees } from "../src/trees";

const leaf = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const lean = (values: bigint[]) =>
  new LeanMerkleTree(23, values, { hashFunction: poseidon2 }).root;

describe("the commitment forest", () => {
  test("should be one empty tree with root 0 before any leaf", () => {
    const trees = new ChainTrees(23);
    expect([trees.activeTreeNumber, trees.nextIndex, trees.activeRoot]).toEqual(
      [0, 0, 0n],
    );
  });

  test("should reproduce the lean tree's root as leaves arrive in batches", () => {
    const trees = new ChainTrees(23);
    trees.addCommitments([
      { treeNumber: 0, leafIndex: 0, commitment: leaf(1) },
      { treeNumber: 0, leafIndex: 1, commitment: leaf(2) },
    ]);
    trees.addCommitments([
      { treeNumber: 0, leafIndex: 2, commitment: leaf(3) },
    ]);
    expect(trees.activeRoot).toBe(lean([1n, 2n, 3n]));
  });

  test("should count the next index from the highest leaf", () => {
    const trees = new ChainTrees(23);
    trees.addCommitments([
      { treeNumber: 0, leafIndex: 0, commitment: leaf(1) },
    ]);
    expect(trees.nextIndex).toBe(1);
  });

  test("should fill a gap in the leaf indices with zero leaves", () => {
    const trees = new ChainTrees(23);
    trees.addCommitments([
      { treeNumber: 0, leafIndex: 0, commitment: leaf(1) },
      { treeNumber: 0, leafIndex: 2, commitment: leaf(3) },
    ]);
    expect(trees.activeRoot).toBe(lean([1n, 0n, 3n]));
  });

  test("should refuse a leaf index it already holds", () => {
    const trees = new ChainTrees(23);
    trees.addCommitments([
      { treeNumber: 0, leafIndex: 0, commitment: leaf(1) },
    ]);
    expect(() =>
      trees.addCommitments([
        { treeNumber: 0, leafIndex: 0, commitment: leaf(9) },
      ]),
    ).toThrow(/leaf 0 of tree 0/);
  });

  test("should open a new tree on rotation and keep the finished one's root", () => {
    const trees = new ChainTrees(23);
    trees.addCommitments([
      { treeNumber: 0, leafIndex: 0, commitment: leaf(1) },
      { treeNumber: 0, leafIndex: 1, commitment: leaf(2) },
      { treeNumber: 1, leafIndex: 0, commitment: leaf(3) },
      { treeNumber: 1, leafIndex: 1, commitment: leaf(4) },
    ]);
    expect([
      trees.activeTreeNumber,
      trees.nextIndex,
      trees.treeRoot(0),
      trees.activeRoot,
    ]).toEqual([1, 2, lean([1n, 2n]), lean([3n, 4n])]);
  });
});

describe("the registry tree", () => {
  test("should reproduce the sdk's registry root", () => {
    const trees = new ChainTrees(23);
    trees.addRegistryLeaves([
      { index: 0, leaf: "7" },
      { index: 3, leaf: "11" },
    ]);
    const expected = new RegistryTree();
    expected.set(0n, 7n);
    expected.set(3n, 11n);
    expect(trees.registryRoot).toBe(expected.root);
  });
});
