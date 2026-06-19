/**
 * Resolves the npm executable name for Node child_process calls.
 */

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

module.exports = {
  npmCommand,
};
