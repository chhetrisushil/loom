export {
  classify,
  classOf,
  collectClassifiedPaths,
  collectMarkedPaths,
  internal,
  pathsOfClass,
  secret,
  sensitive,
  strictest,
} from "./classify";
export type { ClassifiedPath, DataClass } from "./classify";
export { externalized, externalizedPaths, isExternalized } from "./external";
export {
  TAINT_SCAN_EXCEEDED_ORIGIN,
  TAINT_SCAN_MAX_DEPTH,
  TAINT_SCAN_MAX_NODES,
  isTainted,
  nestedTaintOrigin,
  taintOriginLabel,
  TAINT_ORIGIN_LABEL_MAX,
  scanTaint,
  tainted,
  taintOf,
  unwrapTainted,
} from "./taint";
export type { Taint, TaintScan, TaintScanOptions, TaintedValue } from "./taint";
export { REDACTED, maskPaths } from "./redact";
export { expandPaths, hasWildcard } from "./expand";
export { collectUnreachableMarks } from "./unreachable";
export type { UnreachableMark } from "./unreachable";
