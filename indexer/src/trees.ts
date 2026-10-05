import { RegistryTree } from "@bermuda/sdk";
import { LeanMerkleTree, poseidon2 } from "@bermuda/sdk/internal";
import type { CommitmentLeaf } from "./store";

/**
 * The commitment forest and the registry tree, rebuilt from the stored rows with the sdk's own
 * trees, so the indexer checks its rows against the chain exactly as a client will.
 *
 * Commitments: one lean Poseidon2 tree per `treeNumber` (the pool rotates to a fresh tree when
 * the active one fills); a gap in a tree's leaf indices is filled with zero leaves, as the sdk's
 * `leavesFromCommitmentEvents` does. Registry: the fixed-depth tree of `LeafWritten` leaves.
 */
export class ChainTrees {
  private readonly forest = new Map<number, LeanMerkleTree>();
  private readonly registry = new RegistryTree();

  constructor(private readonly height: number) {}

  /** Add commitments, in chain order. */
  addCommitments(leaves: readonly CommitmentLeaf[]): void {
    const byTree = new Map<number, CommitmentLeaf[]>();
    for (const l of leaves) {
      const group = byTree.get(l.treeNumber) ?? [];
      group.push(l);
      byTree.set(l.treeNumber, group);
    }
    for (const [treeNumber, group] of byTree) {
      const tree = this.forest.get(treeNumber);
      const values: bigint[] = [];
      let next = tree?.size ?? 0;
      for (const { leafIndex, commitment } of [...group].sort(
        (a, b) => a.leafIndex - b.leafIndex,
      )) {
        if (leafIndex < next) {
          throw new Error(
            `leaf ${leafIndex} of tree ${treeNumber} is already in the tree`,
          );
        }
        while (next < leafIndex) {
          values.push(0n);
          next += 1;
        }
        values.push(BigInt(commitment));
        next += 1;
      }
      if (tree) tree.bulkInsert(values);
      else
        this.forest.set(
          treeNumber,
          new LeanMerkleTree(this.height, values, { hashFunction: poseidon2 }),
        );
    }
  }

  addRegistryLeaves(
    leaves: ReadonlyArray<{ index: number; leaf: string }>,
  ): void {
    for (const { index, leaf } of leaves)
      this.registry.set(BigInt(index), BigInt(leaf));
  }

  get activeTreeNumber(): number {
    return this.forest.size === 0 ? 0 : Math.max(...this.forest.keys());
  }

  /** The active tree's next free leaf index. */
  get nextIndex(): number {
    return this.forest.get(this.activeTreeNumber)?.size ?? 0;
  }

  get activeRoot(): bigint {
    return this.treeRoot(this.activeTreeNumber);
  }

  /** A tree's root; 0 for a tree without leaves, as the pool's empty root. */
  treeRoot(treeNumber: number): bigint {
    return BigInt(this.forest.get(treeNumber)?.root ?? 0n);
  }

  get registryRoot(): bigint {
    return this.registry.root;
  }
}
