#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { inspectPhpSource } = require("./php-analysis");

const MAX_SOURCE_BYTES = 768 * 1024;
const MAX_STAGED_FILES = 1000;
const MAX_TOTAL_SOURCE_BYTES = 16 * 1024 * 1024;
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "vendor", "node_modules", "storage",
  "coverage", "build", "dist", ".next", ".idea", ".vscode",
]);

function git(root, args, maxBuffer = GIT_OUTPUT_LIMIT) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: null,
    maxBuffer,
    windowsHide: true,
  });
  if (result.error) throw new Error(`Could not run git ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || Buffer.alloc(0)).toString("utf8").trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : "."}`);
  }
  return result.stdout || Buffer.alloc(0);
}

function resolveRepositoryRoot(rootArgument) {
  const requested = path.resolve(rootArgument || process.cwd());
  let details;
  try {
    details = fs.statSync(requested);
  } catch {
    throw new Error(`Directory does not exist: ${requested}`);
  }
  if (!details.isDirectory()) throw new Error(`Path is not a directory: ${requested}`);
  const root = git(requested, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  if (!root) throw new Error("Could not determine the Git working-tree root.");
  return path.resolve(root);
}

function skippedPath(relativePath) {
  const parts = relativePath.split("/");
  const directories = parts.slice(0, -1);
  return directories.some((part, index) => part.startsWith(".") || SKIP_DIRS.has(part) ||
    (index > 0 && `${directories[index - 1]}/${part}` === "bootstrap/cache"));
}

function stagedPhpPaths(root) {
  const output = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
  return output.toString("utf8").split("\0")
    .filter((relativePath) => relativePath && path.posix.extname(relativePath).toLowerCase() === ".php")
    .filter((relativePath) => !skippedPath(relativePath))
    .sort((left, right) => left.localeCompare(right));
}

function stagedBlob(root, relativePath) {
  const spec = `:${relativePath}`;
  const sizeText = git(root, ["cat-file", "-s", spec], 1024).toString("utf8").trim();
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid staged blob size for ${relativePath}.`);
  if (size > MAX_SOURCE_BYTES) return { size, source: null };
  const source = git(root, ["cat-file", "blob", spec], MAX_SOURCE_BYTES + 1);
  if (source.length !== size) throw new Error(`Could not read the complete staged file: ${relativePath}`);
  return { size, source: source.toString("utf8") };
}

function stagedFileMode(root, relativePath) {
  const pathspec = `:(literal)${relativePath}`;
  const output = git(root, ["ls-files", "--stage", "-z", "--", pathspec], 8192).toString("utf8");
  const entry = output.split("\0").find(Boolean);
  const match = entry?.match(/^([0-7]{6}) [0-9a-f]+ ([0-3])\t/);
  if (!match) throw new Error(`Could not determine the staged file mode for ${relativePath}.`);
  if (match[2] !== "0") throw new Error(`Staged file has unresolved merge entries: ${relativePath}`);
  return match[1];
}

function analyzeStaged(root) {
  const paths = stagedPhpPaths(root);
  const limitedPaths = paths.slice(0, MAX_STAGED_FILES);
  let totalBytes = 0;
  let skippedLarge = 0;
  let skippedNonRegular = 0;
  let truncated = paths.length > limitedPaths.length;
  const findings = [];
  let scannedFiles = 0;

  for (const relativePath of limitedPaths) {
    const mode = stagedFileMode(root, relativePath);
    if (mode !== "100644" && mode !== "100755") {
      skippedNonRegular++;
      continue;
    }
    const blob = stagedBlob(root, relativePath);
    if (blob.source === null) {
      skippedLarge++;
      continue;
    }
    if (totalBytes + blob.size > MAX_TOTAL_SOURCE_BYTES) {
      truncated = true;
      break;
    }
    totalBytes += blob.size;
    scannedFiles++;
    const absolutePath = path.join(root, ...relativePath.split("/"));
    findings.push(...inspectPhpSource(blob.source, root, absolutePath));
  }

  findings.sort((left, right) => left.location.localeCompare(right.location) || left.rule.localeCompare(right.rule));
  return { changedPhpFiles: paths.length, scannedFiles, skippedLarge, skippedNonRegular, truncated, findings };
}

function printReport(result) {
  if (!result.changedPhpFiles) {
    process.stdout.write("[Agent DevKit] No staged PHP files; performance scan skipped.\n");
    return;
  }
  process.stdout.write(`[Agent DevKit] Staged PHP performance scan: ${result.scannedFiles}/${result.changedPhpFiles} file(s), ${result.findings.length} candidate finding(s).\n`);
  if (result.skippedLarge) process.stdout.write(`  Skipped ${result.skippedLarge} file(s) larger than ${MAX_SOURCE_BYTES} bytes.\n`);
  if (result.skippedNonRegular) process.stdout.write(`  Skipped ${result.skippedNonRegular} non-regular file(s), such as symbolic links.\n`);
  if (result.truncated) process.stdout.write("  Scan was limited; some staged files may not have been inspected.\n");
  for (const finding of result.findings) {
    process.stdout.write(`\n[REVIEW] ${finding.rule} — ${finding.location}\n`);
    process.stdout.write(`  Evidence: ${finding.evidence}\n  Next step: ${finding.recommendation}\n`);
  }
  if (!result.findings.length) process.stdout.write("  No candidate patterns found.\n");
  process.stdout.write("  Heuristic review only; this warning does not block the commit.\n");
}

function run(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: node staged-perf-scan.js [repository-root]\nReads staged PHP blobs from the Git index; it never scans unstaged file contents.\n");
    return;
  }
  if (args.length > 1) throw new Error("Provide at most one repository-root path.");
  const root = resolveRepositoryRoot(args[0]);
  printReport(analyzeStaged(root));
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`[Agent DevKit] Staged performance scan failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { analyzeStaged, resolveRepositoryRoot, run, stagedPhpPaths };
