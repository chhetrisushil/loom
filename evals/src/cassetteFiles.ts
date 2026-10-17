import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CassetteData, CassetteProvider } from "@loom/eval";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";

// Cassette files, shared by every model area (agentLoop, appgen, planner): one `<id>.json` per case under
// `src/<area>/cassettes/`, `{ "req:<hash>": LlmResponse }`, keys sorted. The files live in `src/` whether the code
// runs from `src/` (vitest) or `dist/` (`pnpm eval`). One implementation, so the atomic write and the layout
// cannot drift between areas.

/** The model's answer at a turn (`turn` = assistant messages so far). */
export type Script = (turn: number, request: LlmRequest) => LlmResponse;

export const cassetteDir = (area: string): string =>
  join(__dirname, "..", "src", area, "cassettes");

export const serializeCassette = (data: CassetteData): string =>
  `${JSON.stringify(data, null, 2)}\n`;

/** The turn a request is at: how many assistant messages the transcript already holds. */
export const turnOf = (req: LlmRequest): number =>
  req.messages.filter((m) => m.role === "assistant").length;

export interface CassetteStore {
  readonly dir: string;
  path(id: string): string;
  load(id: string): CassetteData;
  write(id: string, data: CassetteData): void;
}

export function cassetteStore(area: string, hint = "pnpm eval:author"): CassetteStore {
  const dir = cassetteDir(area);
  const path = (id: string): string => join(dir, `${id}.json`);
  return {
    dir,
    path,
    load(id) {
      const p = path(id);
      if (!existsSync(p)) throw new Error(`no cassette for "${id}" (${p}); run ${hint}`);
      return JSON.parse(readFileSync(p, "utf8")) as CassetteData;
    },
    write(id, data) {
      mkdirSync(dir, { recursive: true });
      // Temp file in the same directory, then an atomic rename: a crash mid-write never leaves a half cassette.
      // `.<id>.json.<pid>.tmp` is git-ignored (evals/.gitignore) and ignored by the dataset sweep.
      const tmp = join(dir, `.${id}.json.${process.pid}.tmp`);
      try {
        writeFileSync(tmp, serializeCassette(data));
        renameSync(tmp, path(id));
      } finally {
        rmSync(tmp, { force: true });
      }
    },
  };
}

/**
 * Author a cassette: run `run` against a scripted "model" in `record` mode and keep every request/response
 * pair. No network and no key: the inner provider is the hand-written script.
 */
export async function authorFromScript(
  run: (provider: LlmProvider) => Promise<unknown>,
  script: Script
): Promise<CassetteData> {
  const inner: LlmProvider = { complete: async (req) => script(turnOf(req), req) };
  const rec = new CassetteProvider({ mode: "record", inner });
  await run(rec);
  return rec.toJSON();
}
