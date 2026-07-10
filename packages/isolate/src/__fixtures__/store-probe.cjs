// Tries to reach durable storage directly (K7.2a): no handles are marshaled,
// and the store driver isn't reachable from the scrubbed child.
module.exports = async () => {
  try {
    require("better-sqlite3");
    return { store: "reachable" };
  } catch (err) {
    return { store: "unreachable", reason: String(err).slice(0, 60) };
  }
};
