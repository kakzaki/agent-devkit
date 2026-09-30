"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "bin", "cli.js");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-devkit tests "));

function run(args, entry = cli) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
}

function success(result, label) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`);
}

try {
  const help = run(["--help"]);
  success(help, "help");
  assert.match(help.stdout, /Agent DevKit/);

  const list = run(["list"]);
  success(list, "list");
  assert.match(list.stdout, /laravel-pr-review/);
  assert.match(list.stdout, /production-db-safety/);
  assert.equal((list.stdout.match(/ — /g) || []).length, 10);

  const project = path.join(temp, "sample project");
  fs.mkdirSync(project);
  const claudeSkill = path.join(project, ".claude", "skills", "laravel-pr-review");
  const openCodeSkill = path.join(project, ".opencode", "skills", "production-db-safety");
  fs.mkdirSync(claudeSkill, { recursive: true });
  fs.writeFileSync(path.join(claudeSkill, "stale.txt"), "old contents", "utf8");

  const install = run([
    "install", "laravel-pr-review", "production-db-safety", "--project", "--root", project, "--claude", "--opencode",
  ]);
  success(install, "install selected skills");
  assert.ok(fs.existsSync(path.join(claudeSkill, "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(claudeSkill, "stale.txt")));
  assert.ok(fs.existsSync(path.join(claudeSkill, "scripts", "perf-scan.js")));
  assert.ok(fs.existsSync(path.join(claudeSkill, "scripts", "import-otel.js")));
  assert.ok(fs.existsSync(path.join(claudeSkill, "scripts", "plan-review.js")));
  assert.ok(fs.existsSync(path.join(claudeSkill, "scripts", "php-analysis.js")));
  assert.ok(fs.existsSync(path.join(openCodeSkill, "SKILL.md")));
  assert.match(fs.readFileSync(path.join(claudeSkill, "SKILL.md"), "utf8"), /N\+1/i);

  const where = run(["where", "production-db-safety", "--project", "--root", project, "--opencode"]);
  success(where, "where");
  assert.match(where.stdout, /\[present\]/);

  const allRoot = path.join(temp, "all-skills");
  fs.mkdirSync(allRoot);
  const installAll = run(["install", "--all", "--project", "--root", allRoot, "--codex"]);
  success(installAll, "install all");
  assert.equal((installAll.stdout.match(/^Installed /gm) || []).length, 10);

  const remove = run(["uninstall", "laravel-pr-review", "--project", "--root", project, "--claude"]);
  success(remove, "uninstall");
  assert.ok(!fs.existsSync(claudeSkill));

  const unknown = run(["install", "not-a-skill", "--project", "--root", project]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown skill/);

  const noSelection = run(["install", "--project", "--root", project]);
  assert.equal(noSelection.status, 2);
  assert.match(noSelection.stderr, /Choose at least one skill/);

  const fixture = path.join(temp, "crlf-root");
  const fixtureCli = path.join(fixture, "bin", "cli.js");
  const fixtureSkill = path.join(fixture, "skills", "line-ending-check");
  fs.mkdirSync(path.dirname(fixtureCli), { recursive: true });
  fs.mkdirSync(fixtureSkill, { recursive: true });
  fs.copyFileSync(cli, fixtureCli);
  fs.writeFileSync(
    path.join(fixtureSkill, "SKILL.md"),
    "---\r\nname: line-ending-check\r\ndescription: Discover skills with Windows line endings.\r\n---\r\n# Test\r\n",
    "utf8"
  );
  const crlfList = run(["list"], fixtureCli);
  success(crlfList, "CRLF metadata");
  assert.match(crlfList.stdout, /Windows line endings/);

  const dbSkill = fs.readFileSync(path.join(root, "skills", "production-db-safety", "SKILL.md"), "utf8");
  assert.match(dbSkill, /review-only/i);
  assert.match(dbSkill, /Never connect/i);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("All Agent DevKit tests passed.\n");
