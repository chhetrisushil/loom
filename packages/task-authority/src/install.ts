import type { GrantSource } from "./broker";
import {
  type TaskAuthorityCodecOptions,
  type TaskAuthorityPrincipalCodec,
  taskAuthorityPrincipalCodec,
} from "./codec";

/** Structural slice of `WorkflowRuntime` this needs, so no kernel dependency is added. */
export interface PrincipalCodecHost {
  composePrincipalCodec(codec: TaskAuthorityPrincipalCodec): void;
  /** ADR 0151 D7: refuse FLOW-scope meters under a prefix. `installTaskAuthority` requires it (see there). */
  reserveEffectDimensions?(prefix: string): void;
}

/**
 * ADR 0150 D3 — compose the task-authority codec onto a runtime (it keeps any codec already set), and reserve
 * the `lease.` meter prefix (ADR 0151 D7) so FLOW code cannot forge `lease.<n>`, `.reserved` or `.returned`:
 * the middleware, the minter and the broker all trust those counters. A host WITHOUT
 * `reserveEffectDimensions` is REFUSED (fail closed): leases would be forgeable. Trust line: grants bound the
 * model and flow code; app-registered effects and middleware are trusted.
 */
export function installTaskAuthority(
  runtime: PrincipalCodecHost,
  o: { source: GrantSource } & TaskAuthorityCodecOptions
): TaskAuthorityPrincipalCodec {
  if (typeof runtime.reserveEffectDimensions !== "function")
    throw new Error(
      "installTaskAuthority: the runtime lacks reserveEffectDimensions (ADR 0151 D7); without it flow code can forge lease counters"
    );
  runtime.reserveEffectDimensions("lease.");
  const { source, ...rest } = o;
  const codec = taskAuthorityPrincipalCodec(source, rest);
  runtime.composePrincipalCodec(codec);
  return codec;
}
