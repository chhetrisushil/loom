import { describe, expect, it } from "vitest";
import * as api from "./index";

describe("@loomwork/task-authority public surface", () => {
  it("exports the version marker and the grant token API and the authorizer", () => {
    expect(Object.keys(api).sort()).toEqual([
      "GrantBrokerError",
      "GrantRevokedError",
      "InMemoryGrantBroker",
      "InMemoryGrantLedger",
      "LeaseDimensionDroppedError",
      "LeaseDurabilityError",
      "LeaseExhaustedError",
      "LeaseGrantInvalidError",
      "LeaseUnmappedError",
      "MAX_JUSTIFICATION",
      "MAX_JUSTIFICATIONS_KEPT",
      "TASK_AUTHORITY_VERSION",
      "TASK_GRANT_DENIAL",
      "TASK_REF_PREFIX",
      "TaskAuthorityPrincipalError",
      "TaskGrantAuthorizer",
      "TaskGrantShapeError",
      "installTaskAuthority",
      "signTaskGrant",
      "taskAuthorityPrincipalCodec",
      "taskGrantDigest",
      "taskLeaseMiddleware",
      "validateGrantShape",
      "verifyTaskGrant",
    ]);
    expect(api.TASK_AUTHORITY_VERSION).toBe("0.0.0-slice1");
  });
});
