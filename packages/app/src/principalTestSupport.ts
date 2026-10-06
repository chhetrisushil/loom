import type { PrincipalChain } from "@loom/effect-runtime";
import type { PrincipalCodec } from "@loom/workflow-runtime";
import type { LoomConfig } from "./defineConfig";

// Test support (not exported from the package): under `security.strict` / `security.compliance`
// `defineConfig` REQUIRES a way to keep the principal's identity out of the log (ADR 0111 D1), so
// the many suites that exercise strict for other reasons wire this in-memory codec.

/** An in-memory ref table: the log carries only an opaque ref; the identity stays here. */
export function testPrincipalCodec(): PrincipalCodec {
  const table = new Map<string, PrincipalChain>();
  return {
    toRef(chain) {
      const ref = `t:${table.size}`;
      table.set(ref, { ...chain });
      return ref;
    },
    fromRef: (ref) => table.get(ref),
  };
}

/** Add the test codec to a config that is strict or has a compliance plugin and names none. */
export function withPrincipalCodec(config: LoomConfig): LoomConfig {
  const security = config.security ?? {};
  const needs =
    (security.strict !== undefined && security.strict !== false) ||
    security.compliance !== undefined ||
    (config as { strict?: unknown }).strict !== undefined ||
    (config as { compliance?: unknown }).compliance !== undefined;
  if (!needs || security.principalCodec !== undefined || security.crypto !== undefined) {
    return config;
  }
  return { ...config, security: { ...security, principalCodec: testPrincipalCodec() } };
}
