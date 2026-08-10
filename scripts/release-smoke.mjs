#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedFiles = [
  "package/LICENSE",
  "package/README.md",
  "package/dist/cli.mjs",
  "package/package.json",
  "package/skill/SKILL.md",
];
const packageNames = ["@p4cs/deardiary", "deardiary-cli"];
const canonicalMcpCommand = "npx -y @p4cs/deardiary@latest mcp";
const removedMcpCommands = ["npx -y deardiary mcp", "npx -y @p4cs/deardiary mcp"];

const fail = (message) => {
  throw new Error(message);
};

const assert = (condition, message) => {
  if (!condition) fail(message);
};

const parseArguments = () => {
  const [version, canonicalTarball, compatibilityTarball, ...extra] = process.argv.slice(2);
  if (
    version === undefined ||
    canonicalTarball === undefined ||
    compatibilityTarball === undefined ||
    extra.length > 0
  ) {
    fail(
      "Usage: node scripts/release-smoke.mjs <version> <@p4cs/deardiary.tgz> <deardiary-cli.tgz>",
    );
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    fail(`Invalid release version '${version}'.`);
  }
  return {
    version,
    tarballs: [resolve(canonicalTarball), resolve(compatibilityTarball)],
  };
};

const runCli = (cliPath, args, options = {}) =>
  execFileSync(cliPath, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 15_000,
  }).trim();

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const parseJson = (text) => JSON.parse(text);

const assertNoWorkspaceProtocols = (value, location = "package.json") => {
  if (typeof value === "string") {
    assert(
      !value.startsWith("catalog:") && !value.startsWith("workspace:"),
      `Unresolved workspace protocol at ${location}: ${value}`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoWorkspaceProtocols(item, `${location}[${String(index)}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertNoWorkspaceProtocols(item, `${location}.${key}`);
    }
  }
};

const makeLifecycleEnvironment = (root) => {
  const home = join(root, "home");
  const configHome = join(home, ".config");
  const codexHome = join(home, ".codex");
  const dataHome = join(root, "data");
  const claudeConfig = join(home, ".claude.json");
  const codexConfig = join(codexHome, "config.toml");
  const openCodeConfig = join(configHome, "opencode", "opencode.json");

  for (const path of [claudeConfig, codexConfig, openCodeConfig]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, path.endsWith(".json") ? "{}\n" : "");
  }

  return {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      CODEX_HOME: codexHome,
      DEARDIARY_HOME: dataHome,
      NO_COLOR: "1",
    },
    paths: { home, dataHome, claudeConfig, codexConfig, openCodeConfig },
  };
};

const assertSetup = (cliPath, smokeRoot, expectedSkill) => {
  const { env, paths } = makeLifecycleEnvironment(smokeRoot);
  const output = runCli(cliPath, ["setup", "--yes", "--guidance", "none"], { env });
  assert(
    output.includes(canonicalMcpCommand),
    "Setup output is missing the canonical MCP command.",
  );
  for (const removedCommand of removedMcpCommands) {
    assert(!output.includes(removedCommand), `Setup output contains '${removedCommand}'.`);
  }

  const claude = readJson(paths.claudeConfig);
  assert(claude.mcpServers?.deardiary?.command === "npx", "Claude MCP command is not npx.");
  assert(
    JSON.stringify(claude.mcpServers?.deardiary?.args) ===
      JSON.stringify(["-y", "@p4cs/deardiary@latest", "mcp"]),
    "Claude MCP arguments are not canonical.",
  );

  const codex = readFileSync(paths.codexConfig, "utf8");
  assert(codex.includes('command = "npx"'), "Codex MCP command is not npx.");
  assert(
    codex.includes('args = ["-y", "@p4cs/deardiary@latest", "mcp"]'),
    "Codex MCP arguments are not canonical.",
  );

  const openCode = readJson(paths.openCodeConfig);
  const openCodeEntry = openCode.mcp?.servers?.deardiary ?? openCode.mcp?.deardiary;
  assert(
    JSON.stringify(openCodeEntry?.command) ===
      JSON.stringify(["npx", "-y", "@p4cs/deardiary@latest", "mcp"]),
    "OpenCode MCP command is not canonical.",
  );
  for (const path of [
    join(paths.home, ".claude", "skills", "deardiary", "SKILL.md"),
    join(paths.home, ".agents", "skills", "deardiary", "SKILL.md"),
  ]) {
    assert(
      readFileSync(path, "utf8") === expectedSkill,
      `Setup installed a stale skill at ${path}.`,
    );
  }

  const entryBody = `packed release smoke ${Date.now().toString(36)}`;
  const logged = parseJson(
    runCli(
      cliPath,
      ["log", "--global", "--json", "--mood", "win", "--tag", "release-smoke", entryBody],
      { env },
    ),
  );
  assert(logged.body === entryBody, "The packed CLI did not return the logged diary entry.");
  assert(logged.mood === "win", "The packed CLI did not persist the requested mood.");

  const entries = parseJson(
    runCli(cliPath, ["read", "--global", "--json", "--tag", "release-smoke"], { env }),
  );
  assert(
    Array.isArray(entries) && entries.length === 1 && entries[0]?.body === entryBody,
    "The packed CLI could not read its isolated SQLite entry.",
  );
  const stats = parseJson(runCli(cliPath, ["stats", "--global", "--json"], { env }));
  assert(stats.total === 1, "The packed CLI reported unexpected isolated SQLite statistics.");

  const databasePath = join(paths.dataHome, "deardiary.db");
  assert(existsSync(databasePath), "The packed CLI did not create its isolated SQLite database.");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert(
      database.prepare("PRAGMA quick_check").get()?.quick_check === "ok",
      "The packed CLI created an unhealthy SQLite database.",
    );
    assert(
      database.prepare("SELECT body FROM entries WHERE id = ?").get(logged.id)?.body === entryBody,
      "The isolated SQLite database is missing the logged entry.",
    );
  } finally {
    database.close();
  }

  const handshake = runCli(cliPath, ["bench-startup"], { env, timeout: 20_000 });
  assert(
    /^MCP startup OK: .* cold handshake, 3 tools, no daemon\.$/u.test(handshake),
    `Packed MCP handshake failed: ${handshake}`,
  );
};

const smokeTarball = (tarball, expectedPackageName, version, rootEngine) => {
  assert(existsSync(tarball), `Missing release tarball: ${tarball}`);
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//u, "").replace(/\/$/u, ""));
  for (const expected of expectedFiles) {
    assert(entries.includes(expected), `${tarball} is missing ${expected}.`);
  }
  assert(
    !entries.some((entry) => entry.includes("node_modules")),
    `${tarball} contains node_modules.`,
  );
  assert(
    !entries.some((entry) => entry.startsWith("package/src/")),
    `${tarball} contains CLI source.`,
  );

  const extractRoot = mkdtempSync(join(tmpdir(), "deardiary-release-smoke-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", extractRoot]);
    const packageRoot = join(extractRoot, "package");
    const manifest = readJson(join(packageRoot, "package.json"));
    assert(
      manifest.name === expectedPackageName,
      `Expected ${tarball} to contain ${expectedPackageName}.`,
    );
    assert(
      manifest.version === version,
      `Expected ${expectedPackageName} manifest version ${version}.`,
    );
    assert(
      manifest.bin?.deardiary === "dist/cli.mjs",
      `${expectedPackageName} has an invalid bin entry.`,
    );
    assert(
      manifest.engines?.node === rootEngine,
      `${expectedPackageName} has a mismatched Node engine.`,
    );
    assertNoWorkspaceProtocols(manifest);

    const packedCliPath = join(packageRoot, manifest.bin.deardiary);
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    const license = readFileSync(join(packageRoot, "LICENSE"), "utf8");
    const skill = readFileSync(join(packageRoot, "skill", "SKILL.md"), "utf8");
    assert(readme.includes("@p4cs/deardiary"), "Packed README omits the canonical package.");
    assert(license.includes("MIT License"), "Packed license is not the declared MIT license.");
    assert(skill.includes("@p4cs/deardiary"), "Packed skill omits the canonical package.");
    assert(
      readFileSync(packedCliPath, "utf8").startsWith("#!/usr/bin/env node\n"),
      "CLI shebang is missing.",
    );

    const installRoot = join(extractRoot, "install");
    mkdirSync(installRoot);
    writeFileSync(join(installRoot, "package.json"), '{"private":true}\n');
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball],
      { cwd: installRoot, stdio: "inherit", timeout: 120_000 },
    );
    const installedPackageRoot = join(
      installRoot,
      "node_modules",
      ...expectedPackageName.split("/"),
    );
    assert(
      existsSync(installedPackageRoot),
      `${expectedPackageName} was not installed from its tarball.`,
    );
    const cliPath = join(installRoot, "node_modules", ".bin", "deardiary");
    assert(
      runCli(cliPath, ["--version"]) === version,
      `${expectedPackageName} CLI version is stale.`,
    );
    const help = runCli(cliPath, ["--help"]);
    assert(
      help.includes("Usage: deardiary <command> [options]"),
      "Packed CLI help is unavailable.",
    );
    assert(help.includes("setup") && help.includes("mcp"), "Packed CLI help is incomplete.");

    assertSetup(cliPath, join(extractRoot, "lifecycle"), skill);
    console.log(`OK ${expectedPackageName}@${version}: contents, CLI, setup, SQLite, and MCP`);
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
};

const { version, tarballs } = parseArguments();
const rootManifest = readJson(join(repoRoot, "package.json"));
const rootEngine = rootManifest.engines?.node;
assert(typeof rootEngine === "string" && rootEngine.length > 0, "Root Node engine is missing.");

for (const [index, packageName] of packageNames.entries()) {
  smokeTarball(tarballs[index], packageName, version, rootEngine);
}

console.log(`Packed release smoke passed for both aliases at ${version}.`);
