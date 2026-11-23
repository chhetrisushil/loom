import { describe, expect, it } from "vitest";
import * as api from "./index";

describe("@loomwork/task-authority public surface", () => {
  it("exports the version marker and the grant token API", () => {
    expect(Object.keys(api).sort()).toEqual([
      "TASK_AUTHORITY_VERSION",
      "TaskGrantShapeError",
      "signTaskGrant",
      "taskGrantDigest",
      "validateGrantShape",
      "verifyTaskGrant",
    ]);
    expect(api.TASK_AUTHORITY_VERSION).toBe("0.0.0-slice1");
  });
});
