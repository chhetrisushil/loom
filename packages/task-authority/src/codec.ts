import type { PrincipalChain } from "@loomwork/effect-runtime";
import type { GrantSource } from "./broker";
import { taskGrantDigest, verifyTaskGrant } from "./grant";

/**
 * Structural twin of the kernel's `PrincipalCodec` (ADR 0111): declared here so this package
 * does not depend on `@loomwork/workflow-runtime`. `composePrincipalCodec` accepts it as is.
 */
export interface TaskAuthorityPrincipalCodec {
  toRef(chain: PrincipalChain): string | undefined;
  fromRef(ref: string, context: { executionId: string }): Promise<PrincipalChain | undefined>;
}

/** The ref prefix: `ta1:<taskId>`. A ref carries a task id only, never a token or an identity. */
export const TASK_REF_PREFIX = "ta1:";
const MAX_TASK_ID = 256;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
const okTaskId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_TASK_ID && !CONTROL.test(id);

/**
 * ADR 0150 D3 — the principal codec. The log records `{ v: 1, ref: "ta1:<taskId>" }`; on every
 * execute `fromRef` asks the app's {@link GrantSource} for the task's CURRENT grant and re-verifies
 * it under `secret` (the source is outside this package). A missing, revoked, unverifiable or
 * throwing source yields `undefined`, which the kernel turns into a deny (ADR 0111 D4); it never
 * falls back. `toRef` takes only a verified grant held by its own actor, on a chain with no
 * tenant, `onBehalfOf` or `delegation` (the orchestration codec owns delegation).
 */
export function taskAuthorityPrincipalCodec(
  source: GrantSource,
  opts: { secret: string }
): TaskAuthorityPrincipalCodec {
  const { secret } = opts;
  return {
    toRef(chain) {
      try {
        const raw = chain.taskGrant;
        if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
        const grant = verifyTaskGrant(secret, raw as never);
        if (grant === undefined) return undefined;
        if (typeof chain.actor !== "string" || chain.actor !== grant.issuedTo) return undefined;
        if (chain.tenant !== undefined || chain.onBehalfOf !== undefined) return undefined;
        if (chain.delegation !== undefined && chain.delegation !== null) return undefined;
        return okTaskId(grant.taskId) ? TASK_REF_PREFIX + grant.taskId : undefined;
      } catch {
        return undefined;
      }
    },
    async fromRef(ref) {
      if (typeof ref !== "string" || !ref.startsWith(TASK_REF_PREFIX)) return undefined;
      try {
        const taskId = ref.slice(TASK_REF_PREFIX.length);
        if (!okTaskId(taskId)) return undefined;
        const raw = await source.current(taskId);
        if (raw === undefined || raw === null) return undefined;
        const grant = verifyTaskGrant(secret, raw);
        if (grant === undefined || grant.taskId !== taskId) return undefined;
        if (
          source.revoked !== undefined &&
          (await source.revoked(taskGrantDigest(grant))) !== false
        )
          return undefined;
        return { actor: grant.issuedTo, taskGrant: grant };
      } catch {
        return undefined;
      }
    },
  };
}
