import { APPGEN_CASES } from "./cases";
import { authorAppgenCassette, store } from "./measure";
import { createTypechecker } from "./typecheck";

// Regenerate every appgen cassette from the hand-written scripts in `cases.ts`: the REAL `planChangesModel` runs over
// the script and each request/response pair is stored. Offline and keyless.

export async function authorAppgen(log: (line: string) => void = console.log): Promise<void> {
  const typechecker = createTypechecker();
  for (const c of APPGEN_CASES) {
    const data = await authorAppgenCassette(c, typechecker);
    store.write(c.id, data);
    log(`authored appgen/${c.id}: ${Object.keys(data).length} exchange(s)`);
  }
}
