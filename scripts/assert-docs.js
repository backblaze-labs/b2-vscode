#!/usr/bin/env node

/**
 * Doc-drift gate for the AGENTS.md + docs/ system of record.
 *
 * Fails (with the fix) when the knowledge base drifts:
 *   1. Required harness files are missing.
 *   2. A relative markdown link points at a missing file.
 *   3. A markdown link's #anchor has no matching heading or <a id>.
 *   4. AGENTS.md exceeds its "map, not manual" length budget.
 *   5. CLAUDE.md / GEMINI.md stop pointing at the canonical AGENTS.md.
 *
 * Generated docs (api-docs/) and node_modules are out of scope.
 */

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const repoRoot = path.join(__dirname, "..");
const AGENTS_MAX_LINES = 120;

const REQUIRED = [
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CLAUDE.md",
  "GEMINI.md",
  "docs/README.md",
  "docs/design-docs/index.md",
  "docs/design-docs/core-beliefs.md",
  "docs/design-docs/conventions.md",
  "docs/exec-plans/tech-debt-tracker.md",
  "docs/product-specs/index.md",
  "docs/references/README.md",
  "docs/QUALITY_SCORE.md",
];

const problems = [];
const abs = (rel) => path.join(repoRoot, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");

// --- 1. required files ---
for (const rel of REQUIRED) {
  if (!fs.existsSync(abs(rel))) {
    problems.push(`missing required doc: ${rel}`);
  }
}

// --- collect markdown files (tracked + untracked, minus ignored) ---
function gitMd(args) {
  return cp.execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}
const listed = [
  ...gitMd(["ls-files", "*.md"]).split("\n"),
  ...gitMd(["ls-files", "--others", "--exclude-standard", "*.md"]).split("\n"),
]
  .map((s) => s.trim())
  .filter(Boolean);
const mdFiles = [...new Set(listed)].filter(
  (f) => fs.existsSync(abs(f)) && !f.startsWith("api-docs/") && !f.startsWith("node_modules/"),
);

// GitHub-style heading slug.
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

// Build the anchor set for every markdown file.
const anchors = new Map();
for (const f of mdFiles) {
  const s = read(f);
  const set = new Set();
  for (const m of s.matchAll(/^#{1,6}\s+(.*)$/gm)) {
    set.add(slug(m[1]));
  }
  for (const m of s.matchAll(/<a\s+id="([^"]+)"/g)) {
    set.add(m[1]);
  }
  anchors.set(f, set);
}

// --- 2 + 3. link and anchor integrity ---
for (const f of mdFiles) {
  const s = read(f);
  const dir = path.dirname(f);
  for (const m of s.matchAll(/\]\(([^)]+)\)/g)) {
    let href = m[1].trim();
    if (/^(https?:|mailto:)/.test(href)) {
      continue;
    }
    const [pathPart, anchor] = href.split("#");
    let targetFile = f;
    if (pathPart) {
      const rel = path.normalize(path.join(dir, pathPart));
      if (!fs.existsSync(path.join(repoRoot, rel))) {
        problems.push(`${f}: broken link -> ${m[1]}`);
        continue;
      }
      targetFile = rel.split(path.sep).join("/");
    }
    if (anchor && anchors.has(targetFile) && !anchors.get(targetFile).has(anchor)) {
      problems.push(`${f}: link anchor #${anchor} not found in ${targetFile}`);
    }
  }
}

// --- 4. AGENTS.md length budget ---
if (fs.existsSync(abs("AGENTS.md"))) {
  const lines = read("AGENTS.md").split("\n").length;
  if (lines > AGENTS_MAX_LINES) {
    problems.push(`AGENTS.md is ${lines} lines (> ${AGENTS_MAX_LINES}); it is a map, not a manual`);
  }
}

// --- 5. tool files point at AGENTS.md ---
for (const rel of ["CLAUDE.md", "GEMINI.md"]) {
  if (fs.existsSync(abs(rel)) && !/AGENTS\.md/.test(read(rel))) {
    problems.push(`${rel} must point to the canonical AGENTS.md`);
  }
}

if (problems.length > 0) {
  console.error("Doc-drift check failed:\n");
  for (const p of problems) {
    console.error(`  ${p}`);
  }
  console.error(
    "\nFix: repair the link/anchor, restore the missing doc, trim AGENTS.md, or " +
      "point the tool file at AGENTS.md. See AGENTS.md and docs/README.md.",
  );
  process.exit(1);
}

console.log(`Doc checks passed (${mdFiles.length} markdown files, links + anchors resolve).`);
