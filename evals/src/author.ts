import { authorAgentLoop } from "./agentLoop/author";
import { authorAppgen } from "./appgen/author";
import { authorPlanner } from "./planner/author";

// `pnpm eval:author`: regenerate EVERY committed cassette from the hand-written scripts. Offline and keyless: no
// provider is constructed and no network is touched. Review the cassette diff afterwards.

async function main(): Promise<void> {
  await authorAgentLoop();
  await authorAppgen();
  await authorPlanner();
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    }
  );
}
