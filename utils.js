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
