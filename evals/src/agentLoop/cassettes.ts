import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CassetteData, CassetteProvider } from "@loom/eval";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { runTask } from "./subject";
import type { Script, Task } from "./tasks";

// One cassette per task: `{ "req:<hash>": LlmResponse }`, keys sorted, committed under `cassettes/`. The files
// live in `src/` whether the code runs from `src/` (vitest) or `dist/` (`pnpm eval`).

export const CASSETTE_DIR = join(__dirname, "..", "..", "src", "agentLoop", "cassettes");

export const cassettePath = (id: string): string => join(CASSETTE_DIR, `${id}.json`);

export const serializeCassette = (data: CassetteData): string =>
  `${JSON.stringify(data, null, 2)}\n`;

export function loadCassette(id: string): CassetteData {
  const p = cassettePath(id);
  if (!existsSync(p)) throw new Error(`no cassette for task "${id}" (${p}); run pnpm eval:author`);
  return JSON.parse(readFileSync(p, "utf8")) as CassetteData;
}

export function writeCassette(id: string, data: CassetteData): void {
  mkdirSync(CASSETTE_DIR, { recursive: true });
  writeFileSync(cassettePath(id), serializeCassette(data));
}

/** The turn a request is at: how many assistant messages the transcript already holds. */
export const turnOf = (req: LlmRequest): number =>
  req.messages.filter((m) => m.role === "assistant").length;

/**
 * Author a cassette: run the REAL loop over a scripted model in `record` mode and keep every request/response
 * pair. No network and no key: the "inner provider" is the hand-written script. `script` overrides the task's
 * own (the fail-proofs author a deliberately wrong one).
 */
export async function authorCassette(
  task: Task,
  script: Script = task.script
): Promise<CassetteData> {
  const inner: LlmProvider = { complete: async (req) => script(turnOf(req), req) };
  const rec = new CassetteProvider({ mode: "record", inner });
  await runTask(task, rec);
  return rec.toJSON();
}
