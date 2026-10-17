import type { CassetteData } from "@loom/eval";
import { type CassetteStore, authorFromScript, cassetteStore } from "../cassetteFiles";
import { runTask } from "./subject";
import type { Script, Task } from "./tasks";

// One cassette per task, committed under `cassettes/` (layout and atomic write: ../cassetteFiles.ts).

const store: CassetteStore = cassetteStore("agentLoop");

export const CASSETTE_DIR = store.dir;
export const cassettePath = (id: string): string => store.path(id);
export const loadCassette = (id: string): CassetteData => store.load(id);
export const writeCassette = (id: string, data: CassetteData): void => store.write(id, data);
export { serializeCassette, turnOf } from "../cassetteFiles";

/**
 * Author a cassette: run the REAL loop over a scripted model in `record` mode and keep every request/response
 * pair. No network and no key: the "inner provider" is the hand-written script. `script` overrides the task's
 * own (the fail-proofs author a deliberately wrong one).
 */
export function authorCassette(task: Task, script: Script = task.script): Promise<CassetteData> {
  return authorFromScript((provider) => runTask(task, provider), script);
}
