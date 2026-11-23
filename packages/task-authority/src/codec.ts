import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrincipalChain } from "@loomwork/effect-runtime";
import type { GrantSource } from "./broker";
import { TaskAuthorityPrincipalError } from "./errors";
import { taskGrantDigest, verifyTaskGrant } from "./grant";

/**
 * Structural twin of the kernel's `PrincipalCodec` (ADR 0111): declared here so this package
 * does not depend on `@loomwork/workflow-runtime`. `composePrincipalCodec` accepts it as is.
 */
export interface TaskAuthorityPrincipalCodec {
  toRef(chain: PrincipalChain): string | undefined;
  fromRef(ref: string, context: { executionId: string }): Promise<PrincipalChain | undefined>;
}

export interface TaskAuthorityCodecOptions {
  secret: string;
  /** Clock for the `exp` check in `toRef`. Default `Date.now`. */
  now?: (() => number) | undefined;
  /** Bound on each `GrantSource` call in `fromRef`. Default 5000. */
  timeoutMs?: number | undefined;
}

/** The ref prefix: `ta1:<taskId>.<mac>`. A ref carries a task id and a MAC only, never a token or an identity. */
export const TASK_REF_PREFIX = "ta1:";
const MAX_TASK_ID = 256;
const MAX_REASON = 256;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
const okTaskId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_TASK_ID && !CONTROL.test(id);
const TIMED_OUT = Symbol("timeout");

/** Race `p` against a timer that is always cleared, so no handle outlives the call. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((r) => {
        timer = setTimeout(() => r(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADR 0150 D3 + R13-R16 — the principal codec. The log records `{ v: 1, ref: "ta1:<taskId>.<mac>" }`,
 * `mac = hmac(secret, "ta1\n" + taskId + "\n" + issuedTo)`, so a ref is bound to its holder. On every
 * execute `fromRef` asks the app's {@link GrantSource} for the task's CURRENT grant, re-verifies it,
 * checks the MAC, the revocation and that the task is claimed by THIS execution.
 *
 * `toRef`: a chain with no `taskGrant` gives `undefined` (other codecs and the default apply). A chain
 * that CARRIES one is either encoded or refused with {@link TaskAuthorityPrincipalError}: returning
 * `undefined` would let the kernel write a default record that drops the grant. It encodes only a
 * verified, unexpired grant held by its own actor, on a chain with no tenant, `onBehalfOf` or `delegation`.
 *
 * `fromRef` answers EVERY `ta1:` ref, never `undefined` (which would let an older codec or the app's
 * resolver restore a principal without the grant): any failure (bad ref, MAC, miss, revoke, verify,
 * claim held elsewhere, throw, timeout) is `{ principalUnresolved }`, which the kernel denies. After a
 * revoke the execution's owner is unknown to the execution access policy (ADR 0111 `unknownOwner`).
 *
 * R17: one grant backs exactly one execution, so a task-governed run cannot `continueAsNew` (the
 * successor copies the ref but has a new execution id) or be forked under the same grant: both are
 * denied at their first effect as "claimed by another execution". A new generation needs a NEW child
 * grant (broker `mint({ parent })`) on a new start. Recording an outcome (`recordOutcome`) as a task
 * principal whose grant has expired is refused with {@link TaskAuthorityPrincipalError} and writes nothing.
 */
export function taskAuthorityPrincipalCodec(
  source: GrantSource,
  opts: TaskAuthorityCodecOptions
): TaskAuthorityPrincipalCodec {
  const { secret } = opts;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const mac = (taskId: string, issuedTo: string): Buffer =>
    createHmac("sha256", secret).update(`ta1\n${taskId}\n${issuedTo}`).digest();
  const refuse = (why: string): never => {
    throw new TaskAuthorityPrincipalError(why);
  };
  return {
    toRef(chain) {
      const raw = chain.taskGrant;
      if (raw === undefined) return undefined;
      let grant: ReturnType<typeof verifyTaskGrant>;
      try {
        grant =
          raw !== null && typeof raw === "object"
            ? verifyTaskGrant(secret, raw as never)
            : undefined;
      } catch {
        grant = undefined;
      }
      if (grant === undefined) return refuse("the task grant does not verify");
      if (typeof chain.actor !== "string" || chain.actor !== grant.issuedTo)
        return refuse("the principal's actor is not the grant's holder");
      if (chain.tenant !== undefined || chain.onBehalfOf !== undefined)
        return refuse("a task grant cannot be recorded with a tenant or onBehalfOf");
      if (chain.delegation !== undefined)
        return refuse("a task grant cannot be recorded with a delegation");
      if (!(grant.exp > now())) return refuse("the task grant has expired");
      if (!okTaskId(grant.taskId)) return refuse("the task id is not recordable");
      return `${TASK_REF_PREFIX}${grant.taskId}.${mac(grant.taskId, grant.issuedTo).toString("base64url")}`;
    },
    async fromRef(ref, context) {
      if (typeof ref !== "string" || !ref.startsWith(TASK_REF_PREFIX)) return undefined;
      let label = "?";
      const fail = (why: string): PrincipalChain => ({
        principalUnresolved: `task grant ${label}: ${why}`.slice(0, MAX_REASON),
      });
      try {
        const body = ref.slice(TASK_REF_PREFIX.length);
        const dot = body.lastIndexOf(".");
        const taskId = body.slice(0, dot);
        if (dot < 0 || !okTaskId(taskId)) return fail("bad ref format");
        label = taskId;
        const given = Buffer.from(body.slice(dot + 1), "base64url");
        const ask = async <T>(p: Promise<T>): Promise<T> => {
          const r = await within(p, timeoutMs);
          if (r === TIMED_OUT) throw TIMED_OUT;
          return r;
        };
        const raw = await ask(source.current(taskId));
        if (raw === undefined || raw === null) return fail("revoked or unknown");
        const grant = verifyTaskGrant(secret, raw);
        if (grant === undefined) return fail("grant does not verify");
        if (grant.taskId !== taskId) return fail("task id mismatch");
        const want = mac(taskId, grant.issuedTo);
        if (given.length !== want.length || !timingSafeEqual(given, want))
          return fail("ref does not match the grant's holder");
        if (
          source.revoked !== undefined &&
          (await ask(source.revoked(taskGrantDigest(grant)))) !== false
        )
          return fail("revoked");
        if ((await ask(source.claim(taskId, context.executionId))) !== true)
          return fail("claimed by another execution");
        return { actor: grant.issuedTo, taskGrant: grant };
      } catch (e) {
        return fail(e === TIMED_OUT ? "grant source timed out" : "grant source failed");
      }
    },
  };
}
