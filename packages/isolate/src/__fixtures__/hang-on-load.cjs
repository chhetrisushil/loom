// Untrusted top-level code that never returns (blocking, so no timer can rescue it).
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
module.exports = async () => ({});
