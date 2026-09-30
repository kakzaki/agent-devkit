"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scriptDirectory = __dirname;
const stagedScanner = path.join(scriptDirectory, "staged-perf-scan.js");
const hookInstaller = path.join(scriptDirectory, "git-hook.js");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-devkit hook test "));

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", timeout: 20000, windowsHide: true });
}

function git(repo, ...args) {
  const result = run("git", args, repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function initRepo(name) {
  const repo = path.join(temp, name);
  fs.mkdirSync(repo, { recursive: true });
  const initialized = run("git", ["init", "--quiet"], repo);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  git(repo, "config", "user.name", "Agent DevKit Tests");
  git(repo, "config", "user.email", "agent-devkit-tests@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  return repo;
}

const nPlusOne = `<?php
foreach ($orders as $order) {
    $line = DB::table('order_lines')->where('order_id', $order->id)->first();
}
`;
const cleanPhp = `<?php
return ['status' => 'ready'];
`;

try {
  const repo = initRepo("Laravel app with spaces");
  const phpFile = path.join(repo, "app", "Order Service.php");
  fs.mkdirSync(path.dirname(phpFile), { recursive: true });
  fs.writeFileSync(phpFile, nPlusOne, "utf8");
  git(repo, "add", "app/Order Service.php");

  // The scanner must see the staged blob, not the newer clean worktree file.
  fs.writeFileSync(phpFile, cleanPhp, "utf8");
  const stagedFinding = run(process.execPath, [stagedScanner, repo]);
  assert.equal(stagedFinding.status, 0, stagedFinding.stderr);
  assert.match(stagedFinding.stdout, /DATABASE_CALL_IN_LOOP/);

  // Conversely, unstaged code must not leak into the index scan.
  git(repo, "add", "app/Order Service.php");
  fs.writeFileSync(phpFile, nPlusOne, "utf8");
  const unstagedOnly = run(process.execPath, [stagedScanner, repo]);
  assert.equal(unstagedOnly.status, 0, unstagedOnly.stderr);
  assert.doesNotMatch(unstagedOnly.stdout, /DATABASE_CALL_IN_LOOP/);

  // Restore the staged candidate and prove the installed hook warns but permits commit.
  fs.writeFileSync(phpFile, nPlusOne, "utf8");
  git(repo, "add", "app/Order Service.php");
  fs.writeFileSync(phpFile, cleanPhp, "utf8");
  const install = run(process.execPath, [hookInstaller, "install", "--root", repo]);
  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /warning-only/i);
  const repeatedInstall = run(process.execPath, [hookInstaller, "install", "--root", repo]);
  assert.equal(repeatedInstall.status, 0, repeatedInstall.stderr || repeatedInstall.stdout);
  assert.match(repeatedInstall.stdout, /already installed/i);
  const stagedBeforeCommit = run(process.execPath, [stagedScanner, repo]);
  assert.match(stagedBeforeCommit.stdout, /DATABASE_CALL_IN_LOOP/, stagedBeforeCommit.stderr);
  const { repository } = require("./git-hook.js");
  assert.equal(fs.existsSync(repository(repo).hookPath), true);

  const commit = run("git", ["commit", "-m", "test staged performance warning"], repo);
  assert.equal(commit.status, 0, `${commit.stderr}\n${commit.stdout}`);
  assert.match(`${commit.stdout}\n${commit.stderr}`, /DATABASE_CALL_IN_LOOP/);
  assert.match(`${commit.stdout}\n${commit.stderr}`, /does not block|does not block the commit|continuing commit/i);

  const removed = run(process.execPath, [hookInstaller, "uninstall", "--root", repo]);
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.equal(fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit")), false);

  const protectedRepo = initRepo("existing hook repo");
  const existingHookPath = path.join(protectedRepo, ".git", "hooks", "pre-commit");
  const existingHook = "#!/bin/sh\nprintf 'custom hook\\n'\n";
  fs.writeFileSync(existingHookPath, existingHook, { encoding: "utf8", mode: 0o755 });
  const refused = run(process.execPath, [hookInstaller, "install", "--root", protectedRepo]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /left untouched/i);
  assert.equal(fs.readFileSync(existingHookPath, "utf8"), existingHook);

  const customRepo = initRepo("custom hooks path repo");
  const customHooks = path.join(temp, "custom hooks directory");
  fs.mkdirSync(customHooks);
  git(customRepo, "config", "core.hooksPath", customHooks);
  const customInstall = run(process.execPath, [hookInstaller, "install", "--root", customRepo]);
  assert.equal(customInstall.status, 0, customInstall.stderr || customInstall.stdout);
  const customHook = path.join(customHooks, "pre-commit");
  assert.equal(fs.existsSync(customHook), true);
  const generatedContents = fs.readFileSync(customHook, "utf8");
  fs.appendFileSync(customHook, "# user modification\n", "utf8");
  const unsafeRemove = run(process.execPath, [hookInstaller, "uninstall", "--root", customRepo]);
  assert.notEqual(unsafeRemove.status, 0);
  assert.equal(fs.readFileSync(customHook, "utf8"), `${generatedContents}# user modification\n`);
  fs.writeFileSync(customHook, generatedContents, "utf8");
  const customRemove = run(process.execPath, [hookInstaller, "uninstall", "--root", customRepo]);
  assert.equal(customRemove.status, 0, customRemove.stderr || customRemove.stdout);
  assert.equal(fs.existsSync(customHook), false);

  const { hookContents } = require("./git-hook.js");
  assert.match(hookContents("C:/DevKit's scripts/staged-perf-scan.js"), /'C:\/DevKit'\\''s scripts\/staged-perf-scan\.js'/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("Laravel staged performance hook tests passed.\n");
