/**
 * A budget must be a finite number > 0. NaN fires at ~1ms, 0 and negatives breach at once,
 * Infinity never fires; omit the field for "no deadline".
 */
export function assertBudget(
  builder: string,
  id: string,
  field: "timeoutMs" | "deadlineMs",
  value: number | undefined
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${builder}("${id}"): ${field} must be a finite number > 0 (got ${String(value)}); omit it for no deadline`
    );
  }
}
