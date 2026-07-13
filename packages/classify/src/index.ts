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
export { REDACTED, maskPaths } from "./redact";
