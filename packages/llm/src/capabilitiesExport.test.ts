import { describe, expect, it } from "vitest";
import { GEMINI_CAPABILITIES, GEMINI_MEDIA_MODELS, capabilitiesForModel } from "./index";

describe("capabilitiesForModel is public", () => {
  it("declares Gemini media for a media family and nothing for others", () => {
    expect(capabilitiesForModel("gemini-2.5-flash", GEMINI_CAPABILITIES, GEMINI_MEDIA_MODELS)).toBe(
      GEMINI_CAPABILITIES
    );
    expect(
      capabilitiesForModel("gemini-1.0-pro", GEMINI_CAPABILITIES, GEMINI_MEDIA_MODELS)
    ).toEqual({});
    expect(GEMINI_CAPABILITIES.image).toContain("image/png");
  });
});
