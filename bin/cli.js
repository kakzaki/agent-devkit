#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECT = path.resolve(__dirname, "..");
const SKILLS = path.join(PROJECT, "skills");
const CLIENT_PATHS = {
  claude: { label: "Claude Code", user: ".claude/skills", project: ".claude/skills" },
  codex: { label: "Codex", user: ".agents/skills", project: ".agents/skills" },
  opencode: { label: "OpenCode", user: ".config/opencode/skills", project: ".opencode/skills" },
};
const COMMANDS = new Set(["help", "list", "install", "uninstall", "where"]);

function readSkill(directory) {
  const id = path.basename(directory);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return null;

  const file = path.join(directory, "SKILL.md");
  if (!fs.existsSync(file)) return null;
  const body = fs.readFileSync(file, "utf8");
  const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error(`${id}: SKILL.md is missing YAML frontmatter.`);

  const metadata = {};
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^(name|description):\s*(.*?)\s*$/);
    if (match) metadata[match[1]] = match[2];
  }
  if (metadata.name !== id || !metadata.description) {
    throw new Error(`${id}: frontmatter must contain matching name and a description.`);
  }
  return { id, directory, description: metadata.description };
}

function catalog() {
  if (!fs.existsSync(SKILLS)) return [];
  return fs.readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSkill(path.join(SKILLS, entry.name)))
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parseArgs(args) {
  const options = {
    command: "help",
    names: [],
    clients: new Set(),
    scope: "user",
    scopeSelected: false,
    all: false,
    root: null,
    help: false,
  };
  let index = 0;

  if (args[0] && COMMANDS.has(args[0])) options.command = args[index++];
  else if (args[0] && !args[0].startsWith("-")) throw new Error(`Unknown command: ${args[0]}`);

  while (index < args.length) {
    const arg = args[index++];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--user" || arg === "--project") {
      const nextScope = arg.slice(2);
      if (options.scopeSelected && options.scope !== nextScope) {
        throw new Error("Choose either --user or --project, not both.");
      }
      options.scope = nextScope;
      options.scopeSelected = true;
    } else if (arg === "--root") {
      if (!args[index] || args[index].startsWith("--")) throw new Error("--root needs a directory path.");
      options.root = args[index++];
    } else if (arg === "--both") {
      options.clients.add("claude");
      options.clients.add("codex");
    } else if (arg === "--all-clients") {
      for (const client of Object.keys(CLIENT_PATHS)) options.clients.add(client);
    } else if (["--claude", "--codex", "--opencode"].includes(arg)) {
      options.clients.add(arg.slice(2));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.names.push(arg);
    }
  }

  if (options.clients.size === 0) {
    options.clients.add("claude");
    options.clients.add("codex");
  }
  if (options.root && options.scope !== "project") {
    throw new Error("--root is only valid with --project.");
  }
  return options;
}

function help() {
  return `Agent DevKit — install reusable coding-agent skills

Usage:
  node bin/cli.js list
  node bin/cli.js <install|uninstall|where> <skill...|--all> [options]

Options:
  --user                 Use the current user's skill directory (default)
  --project              Use a project directory
  --root <path>          Project root (defaults to the current directory)
  --claude               Target Claude Code
  --codex                Target Codex
  --opencode             Target OpenCode
  --both                 Target Claude Code and Codex (default)
  --all-clients          Target all supported clients
  --all                  Select every skill (only when explicitly requested)
  -h, --help             Show this message

Examples:
  node bin/cli.js install laravel-pr-review --project --root ./my-app --opencode
  node bin/cli.js install --all --project --root ./my-app --all-clients
  node bin/cli.js where production-db-safety --user --claude
  node bin/cli.js uninstall web-perf-audit --project --root ./my-app --codex`;
}

function chooseSkills(allSkills, options) {
  if (options.all && options.names.length) throw new Error("Use skill names or --all, not both.");
  const wanted = options.all ? allSkills.map((skill) => skill.id) : options.names;
  if (wanted.length === 0) throw new Error("Choose at least one skill by name, or pass --all.");

  const known = new Map(allSkills.map((skill) => [skill.id, skill]));
  const unknown = wanted.filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`Unknown skill: ${unknown.join(", ")}. Run 'list' to see available skills.`);
  return [...new Set(wanted)].map((name) => known.get(name));
}

function baseFor(client, options) {
  const entry = CLIENT_PATHS[client];
  if (options.scope === "user") return path.join(os.homedir(), entry.user);

  const root = path.resolve(options.root || process.cwd());
  let details;
  try {
    details = fs.statSync(root);
  } catch {
    throw new Error(`Project root does not exist: ${root}`);
  }
  if (!details.isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  return path.join(root, entry.project);
}

function destinationFor(skill, client, options) {
  return path.join(baseFor(client, options), skill.id);
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function installDirectory(source, destination) {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, `.agent-devkit-${path.basename(destination)}-`));
  const candidate = path.join(scratch, "candidate");
  const previous = path.join(scratch, "previous");
  let preserveScratch = false;
  let movedPrevious = false;

  try {
    fs.cpSync(source, candidate, { recursive: true, errorOnExist: true, force: false });
    if (exists(destination)) {
      fs.renameSync(destination, previous);
      movedPrevious = true;
    }

    try {
      fs.renameSync(candidate, destination);
    } catch (replacementError) {
      if (movedPrevious) {
        try {
          fs.renameSync(previous, destination);
          movedPrevious = false;
        } catch (restoreError) {
          preserveScratch = true;
          throw new Error(`Install failed; previous copy remains at ${previous}. ${restoreError.message}`);
        }
      }
      throw replacementError;
    }

    if (movedPrevious) {
      try {
        fs.rmSync(previous, { recursive: true, force: true });
        movedPrevious = false;
      } catch (error) {
        preserveScratch = true;
        process.stderr.write(`Warning: new copy is installed; previous copy remains at ${previous}: ${error.message}\n`);
      }
    }
  } finally {
    if (!preserveScratch && !movedPrevious && exists(scratch)) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.command === "help") {
    process.stdout.write(`${help()}\n`);
    return;
  }

  const allSkills = catalog();
  if (options.command === "list") {
    for (const skill of allSkills) process.stdout.write(`${skill.id} — ${skill.description}\n`);
    return;
  }

  const selected = chooseSkills(allSkills, options);
  for (const skill of selected) {
    for (const client of options.clients) {
      const target = destinationFor(skill, client, options);
      if (options.command === "install") {
        installDirectory(skill.directory, target);
        process.stdout.write(`Installed ${skill.id} for ${CLIENT_PATHS[client].label}: ${target}\n`);
      } else if (options.command === "uninstall") {
        fs.rmSync(target, { recursive: true, force: true });
        process.stdout.write(`Removed ${skill.id} for ${CLIENT_PATHS[client].label}: ${target}\n`);
      } else if (options.command === "where") {
        process.stdout.write(`${exists(target) ? "[present]" : "[absent]"} ${skill.id} for ${CLIENT_PATHS[client].label}: ${target}\n`);
      }
    }
  }
}

try {
  run();
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  if (error.message.includes("Choose at least one skill")) process.stderr.write("Use 'node bin/cli.js --help' for usage.\n");
  process.exitCode = error.message.includes("Choose at least one skill") ? 2 : 1;
}
