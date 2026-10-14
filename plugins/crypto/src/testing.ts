import { createHash } from "node:crypto";
import type { IvContext, IvSource } from "./crypto";

// The deterministic cipher seam (ADR 0130 residuals D7, user ruling 2026-10-14). Exported ONLY from
// this subpath (`@loom/plugin-crypto/testing`), never the main entry. A seeded simulation derives
// each AES-GCM IV from `(seed, stream, sequence, path)` so two runs compare byte for byte. A reused
// IV breaks GCM confidentiality, so the stores refuse a custom `ivSource` when NODE_ENV is
// "production" and the production default stays `randomBytes(12)`.

export type { IvContext, IvSource };

/** An {@link IvSource} that is a pure function of `seed` and the {@link IvContext}. */
export function seededIvSource(seed: string): IvSource {
  return (ctx: IvContext) =>
    createHash("sha256")
      .update(`${seed}\u0000${ctx.streamId}\u0000${ctx.sequence}\u0000${ctx.path}`)
      .digest()
      .subarray(0, 12);
}
