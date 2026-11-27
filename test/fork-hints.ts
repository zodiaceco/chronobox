import type { BlockHints, Rpc } from "../src/lib/chronobox.ts";
import { type Address, sameAddress, toBigInt } from "../src/lib/hex.ts";

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
export async function madeOnFork(rpc: Rpc): Promise<BlockHints & { head: bigint }> {
  const head = toBigInt(await rpc("eth_blockNumber", []));
  return { head, get: () => head + 1n, set: () => undefined };
}

/**
 * The RPC for a test of what the app does without a hint: it reads from block 0, or searches the block in which
 * `address` was made. `address` was made on the fork, after `head`, so before that it has no code and no logs. This
 * answers that part here instead of anvil asking the forked RPC, which searches the whole chain for it.
 * Each fromBlock that the app asks for the logs of `address` goes into `asked`, as the app sent it.
 */
export function madeAfter(rpc: Rpc, address: Address, head: bigint, asked: string[] = []): Rpc {
  const before = (block: unknown) => typeof block === "string" && block.startsWith("0x") && toBigInt(block as `0x${string}`) <= head;
  return async (method, params = []) => {
    const p = params as any[];
    if (method === "eth_getLogs" && typeof p[0]?.address === "string" && sameAddress(p[0].address, address)) {
      const fromBlock = p[0].fromBlock ?? "latest";
      asked.push(fromBlock);
      if (before(p[0].toBlock)) return [];
      if (before(fromBlock)) return rpc(method, [{ ...p[0], fromBlock: "0x" + (head + 1n).toString(16) }, ...p.slice(1)]);
    }
    if (method === "eth_getCode" && typeof p[0] === "string" && sameAddress(p[0] as Address, address) && before(p[1])) return "0x";
    return rpc(method, params);
  };
}
