#!/usr/bin/env node

/**
 * Layer/dependency linter for the architecture in ARCHITECTURE.md.
 *
 * Enforces that imports point DOWN the layer table, never up:
 *   - src/utils/**    must not import from services or the integration layer
 *   - src/services/** must not import from the integration layer
 *
 * Integration = src/{tools,commands,providers,models,ui}. Test and test-support
 * code is exempt. Failure messages name the offending edge and how to fix it.
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const srcRoot = path.join(repoRoot, "src");

const INTEGRATION = ["tools", "commands", "providers", "models", "ui"];

/** Classify a repo-relative src path (posix) into a layer, or null. */
function layerOf(relPosix) {
  if (relPosix.startsWith("src/utils/")) {
    return "utils";
  }
  if (relPosix.startsWith("src/services/")) {
    return "services";
  }
  for (const dir of INTEGRATION) {
    if (relPosix.startsWith(`src/${dir}/`)) {
      return "integration";
    }
  }
  return null; // root/cross-cutting modules are out of scope
}

// Forbidden edges: importer layer -> set of layers it must not import from.
const FORBIDDEN = {
  utils: new Set(["services", "integration"]),
  services: new Set(["integration"]),
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "testSupport") {
        continue;
      }
      walk(full, out);
    } else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function relPosix(absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

const violations = [];

for (const file of walk(srcRoot)) {
  const fromRel = relPosix(file);
  const fromLayer = layerOf(fromRel);
  if (!fromLayer || !FORBIDDEN[fromLayer]) {
    continue;
  }

  const source = fs.readFileSync(file, "utf8");
  const lines = source.split("\n");
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source))) {
    const spec = match[1] || match[2];
    if (!spec || !spec.startsWith(".")) {
      continue; // only intra-repo relative imports
    }

    const targetAbs = path.resolve(path.dirname(file), spec);
    const targetRel = relPosix(targetAbs);
    const toLayer = layerOf(targetRel);
    if (toLayer && FORBIDDEN[fromLayer].has(toLayer)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push({ fromRel, line, spec, fromLayer, toLayer, text: lines[line - 1].trim() });
    }
  }
}

if (violations.length > 0) {
  console.error("Layer violations (imports must point down, never up):\n");
  for (const v of violations) {
    console.error(`  ${v.fromRel}:${v.line}  [${v.fromLayer} -> ${v.toLayer}]  ${v.text}`);
  }
  console.error(
    "\nFix: a lower layer must not import from a higher one. Move the module to " +
      "the layer it actually belongs to, or invert the dependency (extract the " +
      "shared primitive downward). See ARCHITECTURE.md and " +
      "docs/exec-plans/tech-debt-tracker.md.",
  );
  process.exit(1);
}

console.log(`Layer checks passed (${INTEGRATION.length + 2} layers, 0 upward edges).`);
