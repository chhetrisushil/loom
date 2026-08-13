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
export { isTainted, tainted, taintOf, unwrapTainted } from "./taint";
export type { Taint, TaintedValue } from "./taint";
export { REDACTED, maskPaths } from "./redact";
export { expandPaths, hasWildcard } from "./expand";
export { collectUnreachableMarks } from "./unreachable";
export type { UnreachableMark } from "./unreachable";
