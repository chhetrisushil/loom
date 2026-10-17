import { describe, expect, it } from "vitest";
import { NEW_ID, assertSafeId } from "./emit";
import { parseIntent } from "./parseIntent";
import { newIdSlug } from "./slug";

describe("newIdSlug: always a valid NEW id", () => {
  it.each([
    ["2fa login", "item-2fa-login"],
    ["3d render", "item-3d-render"],
    ["--weird--", "weird"],
    ["123", "item-123"],
    ["a  --  b", "a-b"],
    ["trailing- ", "trailing"],
    ["Already Valid", "already-valid"],
    ["deploy-app", "deploy-app"],
  ])("%j -> %s", (input, expected) => {
    expect(newIdSlug(input)).toBe(expected);
    expect(NEW_ID.test(newIdSlug(input))).toBe(true);
  });

  it("unicode-only / symbol-only input gets a stable hashed fallback, never empty", () => {
    const a = newIdSlug("日本語");
    const b = newIdSlug("🚀🚀");
    for (const id of [a, b, newIdSlug("!!!")]) {
      expect(id).toMatch(/^capability-[0-9a-f]{8}$/);
      expect(NEW_ID.test(id)).toBe(true);
    }
    expect(newIdSlug("日本語")).toBe(a); // stable
    expect(a).not.toBe(b); // different inputs do not collapse
  });

  it("blank input stays `app`", () => {
    expect(newIdSlug("")).toBe("app");
    expect(newIdSlug("   ")).toBe("app");
  });

  it("an input that was already a valid id is unchanged", () => {
    for (const id of ["a", "ab-c", "x1-y2", "plan"]) expect(newIdSlug(id)).toBe(id);
  });
});

describe("parseIntent ids survive assertSafeId", () => {
  it("a digit-led capability and step name produce valid ids", () => {
    const spec = parseIntent("Create a 2fa login. Step 3d render.");
    const cap = spec.capabilities[0]!;
    expect(cap.id).toBe("item-2fa-login");
    expect(cap.steps).toEqual(["item-3d-render"]);
    expect(assertSafeId("capability", cap.id)).toBe(cap.id);
    expect(assertSafeId("step", cap.steps[0]!)).toBe(cap.steps[0]);
  });
});
