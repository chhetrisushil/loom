// Deterministic, offline metric sampling — keyed off the host so runs and tests are
// stable (no Date.now / Math.random). `web-1` is healthy; `web-2` is under pressure.
export function sampleCpu(host: string): number {
  return host === "web-1" ? 42 : 88;
}
export function sampleMemory(host: string): number {
  return host === "web-1" ? 55 : 73;
}
export function sampleDisk(host: string): number {
  return host === "web-1" ? 30 : 96;
}
