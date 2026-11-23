import type { GrantSource } from "./broker";
import { type TaskAuthorityPrincipalCodec, taskAuthorityPrincipalCodec } from "./codec";

/** Structural slice of `WorkflowRuntime` this needs, so no kernel dependency is added. */
export interface PrincipalCodecHost {
  composePrincipalCodec(codec: TaskAuthorityPrincipalCodec): void;
}

/** ADR 0150 D3 — compose the task-authority codec onto a runtime (it keeps any codec already set). */
export function installTaskAuthority(
  runtime: PrincipalCodecHost,
  o: { source: GrantSource; secret: string }
): TaskAuthorityPrincipalCodec {
  const codec = taskAuthorityPrincipalCodec(o.source, { secret: o.secret });
  runtime.composePrincipalCodec(codec);
  return codec;
}
