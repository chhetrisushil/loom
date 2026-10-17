import { authorCassette, writeCassette } from "./cassettes";
import { TASKS } from "./tasks";

// Regenerate every agentLoop cassette from the hand-written scripts in `tasks.ts` (`pnpm eval:author`, via ../author.ts).
// Offline and keyless; run it after a legitimate prompt or menu change makes a replay miss, then review the diff.

export async function authorAgentLoop(log: (line: string) => void = console.log): Promise<void> {
  for (const t of TASKS) {
    const data = await authorCassette(t);
    writeCassette(t.id, data);
    log(`authored agentLoop/${t.id}: ${Object.keys(data).length} exchange(s)`);
  }
}
