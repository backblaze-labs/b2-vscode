#!/usr/bin/env node

const { execFileSync } = require("node:child_process");

function git(args, options = {}) {
  const output = execFileSync("git", args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });

  return typeof output === "string" ? output.trim() : "";
}

function main() {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    console.log("Skipping Git hook installation outside a Git worktree.");
    return;
  }

  const desiredHooksPath = ".githooks";
  const currentHooksPath = (() => {
    try {
      return git(["config", "--local", "--get", "core.hooksPath"]);
    } catch {
      return "";
    }
  })();

  if (currentHooksPath !== desiredHooksPath) {
    git(["config", "--local", "core.hooksPath", desiredHooksPath], { stdio: "inherit" });
  }

  console.log(`Git hooks installed from ${desiredHooksPath}.`);
}

main();
