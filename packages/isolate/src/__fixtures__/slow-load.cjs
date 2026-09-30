// A well-behaved tool whose MODULE LOAD is slow — a deterministic stand-in for a cold child
// process under load (L23): the cost is paid at require time, before the tool's own code runs,
// so it is startup, never the tool's runtime. Blocking (not a timer) so it cannot be short-cut.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300);
module.exports = async (input) => ({ echoed: input });
