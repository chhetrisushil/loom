import { authorCassette, writeCassette } from "./cassettes";
import { TASKS } from "./tasks";

// `pnpm eval:author`: regenerate every cassette from the hand-written scripts in `tasks.ts`. Offline and keyless;
// run it after a legitimate prompt or menu change makes a replay miss, then review the cassette diff.

async function main(): Promise<void> {
  for (const t of TASKS) {
    const data = await authorCassette(t);
    writeCassette(t.id, data);
    console.log(`authored ${t.id}: ${Object.keys(data).length} exchange(s)`);
  }
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
