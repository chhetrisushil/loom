/**
 * The default erasure subject (the executionId). ONE function shared by `EncryptingEventStore`,
 * `EncryptingArchiveStore` and the snapshot store, so the kernel's archive guard (ADR 0138) can tell
 * "same mapping" from "a custom `subjectOf` on one side only" by identity.
 */
export const defaultSubjectOf = (s: { executionId: string }): string => s.executionId;
