/**
 * Resolves the npm executable name for Node child_process calls.
 */

const os = require("os");
const path = require("path");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmRegistry = "https://registry.npmjs.org/";
const npmGlobalConfig = path.join(os.tmpdir(), "b2-vscode-empty-npm-globalconfig");

const trustedNpmConfig = Object.freeze({
  registry: npmRegistry,
  userconfig: os.devNull,
  globalconfig: npmGlobalConfig,
});

const trustedNpmConfigArgs = Object.freeze([
  `--registry=${trustedNpmConfig.registry}`,
  `--userconfig=${trustedNpmConfig.userconfig}`,
  `--globalconfig=${trustedNpmConfig.globalconfig}`,
]);

const trustedNpmEnvPins = Object.freeze({
  npm_config_registry: trustedNpmConfig.registry,
  npm_config_audit_registry: trustedNpmConfig.registry,
  npm_config_userconfig: trustedNpmConfig.userconfig,
  npm_config_globalconfig: trustedNpmConfig.globalconfig,
  npm_config_ignore_scripts: "true",
  npm_config_strict_ssl: "true",
  npm_config_offline: "false",
  npm_config_prefer_offline: "false",
  npm_config_proxy: "",
  npm_config_https_proxy: "",
  npm_config_noproxy: "",
  npm_config_cafile: "",
  npm_config_ca: "",
  npm_config_cert: "",
  npm_config_key: "",
});

function trustedNpmEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/iu.test(key)) {
      delete env[key];
    }
  }

  Object.assign(env, trustedNpmEnvPins);
  return env;
}

module.exports = {
  npmCommand,
  trustedNpmConfig,
  trustedNpmConfigArgs,
  trustedNpmEnvPins,
  npmGlobalConfig,
  npmRegistry,
  trustedNpmEnv,
};
