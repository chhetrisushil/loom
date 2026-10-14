import { createHash } from "node:crypto";
import { type IvContext, type IvSource, brandIvSource } from "./crypto";

// The deterministic cipher seam (ADR 0130 residuals D7, user ruling 2026-10-14). Exported ONLY from
// this subpath (`@loom/plugin-crypto/testing`), never the main entry. A seeded simulation derives
// each AES-GCM IV from `(seed, stream, sequence, path)` so two runs compare byte for byte. A reused
// IV breaks GCM confidentiality, so the stores accept an `ivSource` ONLY if it was minted here
// (a module-private brand; a plain function is refused) AND the process is a test run (NODE_ENV
// "test" or VITEST set); the production default stays `randomBytes(12)`.
//
// Seeded snapshot IVs are fixed per (execution, sequence, path): two DIFFERENT states sealed at the
// same sequence reuse an IV (under the same key). Harmless for a byte-for-byte simulation, never
// acceptable anywhere else; that is why this lives behind the test-only subpath.

export type { IvContext, IvSource };

/** An {@link IvSource} that is a pure function of `seed` and the {@link IvContext}. */
export function seededIvSource(seed: string): IvSource {
  return brandIvSource((ctx: IvContext) =>
    createHash("sha256")
      .update(`${seed}\u0000${ctx.streamId}\u0000${ctx.sequence}\u0000${ctx.path}`)
      .digest()
      .subarray(0, 12)
  );
}
