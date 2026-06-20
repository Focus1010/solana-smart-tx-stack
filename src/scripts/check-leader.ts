/**
 * Validates Jito leader detection by polling getNextScheduledLeader().
 *
 * Run: npx ts-node src/scripts/check-leader.ts
 *
 * Exits 2 when all iterations return null/zero leader info (actionable warning).
 */

import "dotenv/config";
import { Logger } from "../utils/logger";
import { createJitoClient } from "../jito/create-jito-client";
import { config } from "../config";

function isUsableLeaderInfo(info: {
  nextLeaderIdentity: string | null;
  nextLeaderSlot: number;
}): boolean {
  return (
    info.nextLeaderIdentity !== null &&
    info.nextLeaderIdentity.length > 0 &&
    info.nextLeaderSlot > 0
  );
}

async function main(): Promise<void> {
  const logger = new Logger(config.stack.logDir);
  const client = createJitoClient(logger);

  console.log("\nJito leader detection check");
  console.log(`Transport: ${client.transport}`);
  console.log(`Endpoint:  ${config.jito.blockEngineUrl || config.jito.rpcUrl}\n`);

  let usableCount = 0;

  for (let i = 0; i < 5; i++) {
    const info = await client.getNextScheduledLeader();
    console.log(i, info);

    if (isUsableLeaderInfo(info)) {
      usableCount++;
    }

    if (i < 4) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  client.close();

  if (usableCount === 0) {
    console.warn(
      "\n[WARN] Leader detection returned null/zero nextLeaderSlot or nextLeaderIdentity " +
      "for all 5 attempts. Enable JITO_USE_GRPC=true for gRPC SearcherClient support, " +
      "or verify the block-engine endpoint exposes getNextScheduledLeader."
    );
    process.exit(2);
  }

  console.log(`\n[OK] Usable leader info on ${usableCount}/5 attempts.\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
