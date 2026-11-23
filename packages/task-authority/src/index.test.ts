import { describe, expect, it } from "vitest";
import * as api from "./index";

describe("@loomwork/task-authority public surface", () => {
  it("exports the version marker and the grant token API and the authorizer", () => {
    expect(Object.keys(api).sort()).toEqual([
      "CHILD_LEASE_TOOL",
      "GrantBrokerError",
      "GrantRevokedError",
      "InMemoryGrantBroker",
      "InMemoryGrantLedger",
      "LINEAGE_ORIGIN_PREFIX",
      "LeaseChildEffectUnbrandedError",
      "LeaseDimensionDroppedError",
      "LeaseDurabilityError",
      "LeaseExhaustedError",
      "LeaseGrantInvalidError",
      "LeaseUnmappedError",
      "MAX_JUSTIFICATION",
      "MAX_JUSTIFICATIONS_KEPT",
      "READS_MAX_STARS",
      "READS_MAX_TOTAL",
      "RENEWAL_GATE",
      "RENEWAL_TERMINAL_NAMES",
      "RenewalDeniedError",
      "TASK_AUTHORITY_VERSION",
      "TASK_GRANT_DENIAL",
      "TASK_REF_PREFIX",
      "TASK_REF_PREFIX_V2",
      "TaskAuthorityPrincipalError",
      "TaskGrantAuthorizer",
      "TaskGrantShapeError",
      "answerRenewal",
      "childGrantMinter",
      "childLeaseEffect",
      "globCovers",
      "installTaskAuthority",
      "isChildLeaseEffect",
      "isRenewable",
      "lineageOrigin",
      "lineageSend",
      "lineageTainter",
      "renewalDecisionId",
      "renewalResumeSchema",
      "renewalViewDigest",
      "reserveChildLease",
      "signTaskGrant",
      "taskAuthorityPrincipalCodec",
      "taskGrantDigest",
      "taskLeaseMiddleware",
      "validateGrantShape",
      "verifyTaskGrant",
      "widensReadsOrSandbox",
      "withRenewal",
      "wrapLineage",
    ]);
    expect(api.TASK_AUTHORITY_VERSION).toBe("0.0.0-slice1");
  });

  it("keeps the conformance kit off the main entry (it needs the optional runtime peers)", async () => {
    expect(Object.keys(api)).not.toContain("checkTaskAuthorityConformance");
    const kit = await import("./conformance");
    expect(Object.keys(kit).sort()).toEqual([
      "CONFORMANCE_CHECK_IDS",
      "checkTaskAuthorityConformance",
    ]);
  });
});
