/**
 * Resolves the npm executable name for Node child_process calls.
 */

const os = require("os");
const path = require("path");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmRegistry = "https://registry.npmjs.org/";
const npmGlobalConfig = path.join(os.tmpdir(), "b2-vscode-empty-npm-globalconfig");

const trustedNpmConfigArgs = [
  `--registry=${npmRegistry}`,
  `--userconfig=${os.devNull}`,
  `--globalconfig=${npmGlobalConfig}`,
];

function trustedNpmEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "npm_config_registry" ||
      normalized === "npm_config_audit_registry" ||
      normalized === "npm_config_userconfig" ||
      normalized === "npm_config_globalconfig" ||
      normalized === "npm_config_omit" ||
      normalized === "npm_config_include" ||
      normalized === "npm_config_only" ||
      normalized === "npm_config_production"
    ) {
      delete env[key];
    }
  }

  env.npm_config_registry = npmRegistry;
  env.npm_config_userconfig = os.devNull;
  env.npm_config_globalconfig = npmGlobalConfig;
  env.npm_config_ignore_scripts = "true";
  return env;
}

module.exports = {
  npmCommand,
  npmGlobalConfig,
  npmRegistry,
  trustedNpmConfigArgs,
  trustedNpmEnv,
};
