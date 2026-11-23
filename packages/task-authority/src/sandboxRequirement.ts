import { CapabilityDeniedError, type EffectMiddleware } from "@loomwork/effect-runtime";
import { TASK_GRANT_DENIAL } from "./authorizer";
import { LeaseGrantInvalidError } from "./errors";
import { type GrantKeys, type TaskGrant, sealKeys, verifyTaskGrant } from "./grant";

export interface SandboxRequirementOptions {
  /** The grant secret (as `taskLeaseMiddleware`): `sandbox` is read from the VERIFIED grant only. */
  secret: GrantKeys;
  /** Where to look the registered effect up (`() => effectRuntime`; a getter, since the runtime is built AFTER its middleware). */
  effects: () => { entries(): Iterable<[string, unknown]> };
}

/** The sandbox backend's capability keys (ADR 0144 D4). S6's `read` marker shares the field but is not one of them. */
const SANDBOX_KEYS = ["language", "network", "freshPerRun"] as const;
interface Vetted {
  network: unknown;
  freshPerRun: unknown;
}

/**
 * ADR 0150 D10, S-R6 (slice-2 S8): per call, a grant with `sandbox: "isolated"` refuses a SANDBOX effect whose
 * declared backend is not `network: "none"` AND `freshPerRun: true`. The refusal is a terminal `CapabilityDeniedError`
 * (`task-grant:sandbox`): no renewal changes what a backend is, so it is not parkable.
 * - A sandbox effect is one whose `capabilities` carries any sandbox key (`language`, `network`, `freshPerRun`),
 *   so `{ read: true }` alone is NOT a sandbox. A partially declared backend is checked, and fails closed.
 * - The caps are read once per registered effect object and cached (a `SandboxEffect` already freezes a vetted copy),
 *   so mutating a backend's caps after the first call cannot weaken the check.
 * - Only sandbox effects are governed. An effect with no sandbox declaration (an ambient tool) is NOT refused: D10 and
 *   S-R6 name no rule for it, and nothing in an effect says it has ambient authority.
 * - A grant with no `sandbox`, and a run with NO task grant, are not governed here (the authorizer decides).
 * Place it anywhere in `effectMiddleware`; BEFORE `taskLeaseMiddleware` a refusal burns no lease unit.
 */
export function sandboxRequirement(opts: SandboxRequirementOptions): EffectMiddleware {
  const secret = sealKeys(opts.secret);
  const seen = new WeakMap<object, Vetted | null>();
  const vet = (effect: unknown): Vetted | null => {
    const caps = (effect as { capabilities?: unknown } | null)?.capabilities;
    if (typeof effect !== "object" || effect === null) return null;
    const cached = seen.get(effect);
    if (cached !== undefined) return cached;
    const isSandbox =
      typeof caps === "object" && caps !== null && SANDBOX_KEYS.some((k) => Object.hasOwn(caps, k));
    const vetted = isSandbox
      ? { network: (caps as Vetted).network, freshPerRun: (caps as Vetted).freshPerRun }
      : null;
    seen.set(effect, vetted);
    return vetted;
  };
  return async (ctx, _input, next) => {
    const claimed = ctx.principal?.taskGrant as TaskGrant | undefined;
    if (claimed === undefined) return next();
    const grant = verifyTaskGrant(secret, claimed);
    if (grant === undefined) throw new LeaseGrantInvalidError();
    if (grant.sandbox !== "isolated") return next();
    const toolId = ctx.toolId ?? "";
    for (const [id, effect] of opts.effects().entries()) {
      if (id !== toolId) continue;
      const v = vet(effect);
      if (v !== null && (v.network !== "none" || v.freshPerRun !== true))
        throw new CapabilityDeniedError(
          toolId,
          `${TASK_GRANT_DENIAL.sandbox}: an isolated grant needs a backend with network "none" and freshPerRun true (declared network ${JSON.stringify(v.network)}, freshPerRun ${JSON.stringify(v.freshPerRun)})`
        );
    }
    return next();
  };
}
