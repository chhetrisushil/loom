// Never settles — the kill path (abort / timeoutMs) must reclaim it.
module.exports = () => new Promise(() => {});
