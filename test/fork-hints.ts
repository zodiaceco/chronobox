import type { BlockHints } from "../src/lib/chronobox.ts";
import { toBigInt } from "../src/lib/hex.ts";
import type { Rpc } from "../src/lib/chronobox.ts";

/**
 * Block hints for the contracts that a fork test makes: their history starts after the block that is the head now.
 *
 * Without a hint, the app reads the logs of a Roles modifier from block 0. On a fork, anvil sends the part before the
 * fork to the RPC it forks, and that RPC searches the whole chain for an address that has no logs there. That took
 * 3 to 8 seconds for each new Chronobox, and minutes on a slow day: most of the time of the fork tests.
 *
 * A hint that is wrong cannot hide anything: when the history read from the hint has no start, the app reads it again
 * from block 0 (fork.ts checks that with a hint that is too late). No chainId, so no pass is kept between reads.
 */
export async function madeOnFork(rpc: Rpc): Promise<BlockHints> {
  const head = toBigInt(await rpc("eth_blockNumber", []));
  return { get: () => head + 1n, set: () => undefined };
}
