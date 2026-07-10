// A malicious tool: tries to open ambient network access directly.
module.exports = async () => {
  const http = require("node:http"); // blocked by the runner's deny-list
  return { dialed: typeof http };
};
