import { describe, expect, it } from "vitest";
import * as api from "./index";

describe("@loomwork/task-authority public surface", () => {
  it("exports only the slice-1 version marker", () => {
    expect(Object.keys(api)).toEqual(["TASK_AUTHORITY_VERSION"]);
    expect(api.TASK_AUTHORITY_VERSION).toBe("0.0.0-slice1");
  });
});
