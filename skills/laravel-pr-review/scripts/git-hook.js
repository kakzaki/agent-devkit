#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MARKER = "# Agent DevKit Laravel performance warning hook v1";
const SCANNER = path.join(__dirname, "staged-perf-scan.js");

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`Could not run git ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : "."}`);
  }
  return (result.stdout || "").trim();
}

function repository(rootArgument) {
  const requested = path.resolve(rootArgument || process.cwd());
  let details;
  try {
    details = fs.statSync(requested);
  } catch {
    throw new Error(`Directory does not exist: ${requested}`);
  }
  if (!details.isDirectory()) throw new Error(`Path is not a directory: ${requested}`);
  const root = git(requested, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error("Could not determine the Git working-tree root.");
  const absoluteRoot = path.resolve(root);
  const hooksDirectory = git(absoluteRoot, ["rev-parse", "--git-path", "hooks"]);
  if (!hooksDirectory) throw new Error("Could not determine the Git hooks directory.");
  return { root: absoluteRoot, hookPath: path.resolve(absoluteRoot, hooksDirectory, "pre-commit") };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hookContents(scanner = SCANNER) {
  const shellPath = scanner.replace(/\\/g, "/");
  return `#!/bin/sh\n${MARKER}\nnode ${shellQuote(shellPath)}\nscan_status=$?\nif [ "$scan_status" -ne 0 ]; then\n  printf '%s\\n' '[Agent DevKit] Performance scan did not complete; continuing commit.' >&2\nfi\nexit 0\n`;
}

function existingFile(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function install(rootArgument) {
  const { hookPath } = repository(rootArgument);
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  const current = existingFile(hookPath);
  const expected = hookContents();
  if (current) {
    if (current.isFile() && fs.readFileSync(hookPath, "utf8") === expected) {
      process.stdout.write(`Agent DevKit warning hook is already installed: ${hookPath}\n`);
      return hookPath;
    }
    throw new Error(`Existing pre-commit hook was left untouched: ${hookPath}. Move or edit it yourself before installing.`);
  }

  let descriptor;
  try {
    descriptor = fs.openSync(hookPath, "wx", 0o755);
    fs.writeFileSync(descriptor, expected, "utf8");
    fs.fchmodSync(descriptor, 0o755);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(hookPath); } catch {}
    }
    if (error.code === "EEXIST") throw new Error(`A pre-commit hook appeared during installation and was left untouched: ${hookPath}`);
    throw error;
  }
  fs.closeSync(descriptor);
  process.stdout.write(`Installed warning-only Agent DevKit pre-commit hook: ${hookPath}\n`);
  return hookPath;
}

function uninstall(rootArgument) {
  const { hookPath } = repository(rootArgument);
  const current = existingFile(hookPath);
  if (!current) {
    process.stdout.write(`No pre-commit hook found: ${hookPath}\n`);
    return false;
  }
  if (!current.isFile() || fs.readFileSync(hookPath, "utf8") !== hookContents()) {
    throw new Error(`Pre-commit hook was not removed because it is not an unchanged Agent DevKit hook: ${hookPath}`);
  }
  fs.unlinkSync(hookPath);
  process.stdout.write(`Removed Agent DevKit pre-commit hook: ${hookPath}\n`);
  return true;
}

function help() {
  return `Agent DevKit Laravel performance hook\n\nUsage:\n  node git-hook.js <install|uninstall> [--root <repository>]\n\nThe hook audits staged PHP as a warning only, does not overwrite another hook,\nand can be removed with the uninstall command. The default repository is the current directory.\n`;
}

function run(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(help());
    return;
  }
  const command = args[0];
  if (command !== "install" && command !== "uninstall") throw new Error(`Unknown command: ${command}`);
  let root = null;
  let index = 1;
  while (index < args.length) {
    const arg = args[index++];
    if (arg !== "--root" || !args[index] || args[index].startsWith("--")) {
      throw new Error("Use --root followed by a repository directory.");
    }
    if (root !== null) throw new Error("Provide --root only once.");
    root = args[index++];
  }
  return command === "install" ? install(root) : uninstall(root);
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { hookContents, install, repository, run, uninstall };
