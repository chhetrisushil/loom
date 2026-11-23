import { describe, expect, it } from "vitest";
import * as api from "./index";

describe("@loomwork/task-authority public surface", () => {
  it("exports the version marker and the grant token API and the authorizer", () => {
    expect(Object.keys(api).sort()).toEqual([
      "GrantBrokerError",
      "InMemoryGrantBroker",
      "InMemoryGrantLedger",
      "MAX_JUSTIFICATION",
      "MAX_JUSTIFICATIONS_KEPT",
      "TASK_AUTHORITY_VERSION",
      "TASK_GRANT_DENIAL",
      "TASK_REF_PREFIX",
      "TaskGrantAuthorizer",
      "TaskGrantShapeError",
      "installTaskAuthority",
      "signTaskGrant",
      "taskAuthorityPrincipalCodec",
      "taskGrantDigest",
      "validateGrantShape",
      "verifyTaskGrant",
    ]);
    expect(api.TASK_AUTHORITY_VERSION).toBe("0.0.0-slice1");
  });
});
