// The symlink-safe writer lives in @loom/appgen (the lockfile writer needs it and cli already depends
// on appgen, so this is the only dependency direction that adds no edge).
export { assertNoSymlinkPath, containmentRootFor, safeWriteFile } from "@loom/appgen";
