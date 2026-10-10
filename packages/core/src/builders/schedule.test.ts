import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schedule$ } from "./schedule";

// ADR 0126 D5: an hourly / sub-hourly cron in a DST zone loses the fall-back hour's second pass,
// so schedule$ says so once, at definition time.
describe("schedule$ - sub-hourly cron in a DST zone", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const def = (id: string, cron: string, timeZone?: string) =>
    schedule$({ id, cron, flowId: "f", ...(timeZone !== undefined && { timeZone }) });

  it("warns for */15 and 0 * * * * in a DST zone (both hemispheres)", () => {
    def("w-quarter", "*/15 * * * *", "America/New_York");
    def("w-hourly", "0 * * * *", "Europe/Berlin");
    def("w-south", "0 */2 * * *", "Australia/Sydney");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain("w-quarter");
  });

  it("warns once per schedule id", () => {
    def("w-once", "*/15 * * * *", "America/New_York");
    def("w-once", "*/15 * * * *", "America/New_York");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays silent for UTC (explicit or default)", () => {
    def("n-utc-default", "*/15 * * * *");
    def("n-utc", "0 * * * *", "UTC");
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent for zones without DST", () => {
    def("n-tokyo", "*/15 * * * *", "Asia/Tokyo");
    def("n-kolkata", "0 * * * *", "Asia/Kolkata");
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent for a fixed wall time in a DST zone", () => {
    def("n-fixed", "30 1 * * *", "America/New_York");
    def("n-fixed-list", "0 9,17 * * 1-5", "Europe/Berlin");
    expect(warn).not.toHaveBeenCalled();
  });
});
