#!/usr/bin/env bun
/**
 * Export the public LifeOS payload into a Codex installation.
 *
 * Dry-run is the default. The link mode keeps Codex's USER/MEMORY state local
 * while its doctrine is read from the canonical Claude LifeOS tree.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { detectDevTree } from "./InstallEngine";

type Mode = "link" | "copy";
type Args = { codexHome: string; source: string; mode: Mode; apply: boolean; withHooks: boolean; allowDev: boolean };
type Report = {
  apply: boolean; mode: Mode; codexHome: string; source: string;
  wouldCopy: string[]; wouldGenerate: string[]; wouldArchive: string[]; protectedUntouched: string[];
  warnings: string[];
};

const PROTECTED = ["auth.json", "history.jsonl", "sessions", "config.toml", "settings.json", "memories", "cache", "installation_id"];
const SYSTEM_EXCLUDES = new Set(["USER", "MEMORY", "node_modules", ".git"]);
const START = "<!-- LIFEOS-CODEX-COMPAT:START -->";
const END = "<!-- LIFEOS-CODEX-COMPAT:END -->";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
    source: resolve(import.meta.dir, ".."),
    mode: "link", apply: false, withHooks: false, allowDev: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--apply") args.apply = true;
    else if (value === "--with-hooks") args.withHooks = true;
    else if (value === "--allow-dev") args.allowDev = true;
    else if (value === "--codex-home") args.codexHome = resolve(argv[++i] || "");
    else if (value === "--source") args.source = resolve(argv[++i] || "");
    else if (value === "--mode") {
      const mode = argv[++i];
      if (mode !== "link" && mode !== "copy") throw new Error("--mode must be link or copy");
      args.mode = mode;
    } else if (value === "--help" || value === "-h") {
      console.log("Usage: bun CodexExport.ts [--codex-home <dir>] [--source <root>] [--mode link|copy] [--with-hooks] [--apply] [--allow-dev]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function isProtected(root: string, target: string): boolean {
  const rel = relative(root, target).replace(/\\/g, "/");
  return rel.split("/").some((part) => PROTECTED.includes(part) || /\.sqlite(?:$|[-.])/i.test(part));
}

function assertWritable(root: string, target: string): void {
  if (isProtected(root, target)) throw new Error(`refusing to mutate protected Codex state: ${target}`);
}

function listTree(root: string, excluded = SYSTEM_EXCLUDES): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && excluded.has(entry.name)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  walk(root);
  return files;
}

function copyTree(source: string, destination: string, root: string, report: Report, apply: boolean, excluded = SYSTEM_EXCLUDES): void {
  for (const file of listTree(source, excluded)) {
    const target = join(destination, relative(source, file));
    assertWritable(root, target);
    report.wouldCopy.push(target);
    if (!apply) continue;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target, { force: true });
  }
}

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, "-"); }

function archiveStaleSystemTree(lifeosDir: string, codexHome: string, report: Report, apply: boolean): void {
  if (!existsSync(lifeosDir)) return;
  const systemEntries = readdirSync(lifeosDir).filter((name) => !SYSTEM_EXCLUDES.has(name));
  if (systemEntries.length === 0) return;
  const archive = join(codexHome, "backups", `LIFEOS-system-${stamp()}`);
  report.wouldArchive.push(archive);
  if (!apply) return;
  mkdirSync(archive, { recursive: true });
  for (const name of systemEntries) renameSync(join(lifeosDir, name), join(archive, name));
}

function readVersion(payload: string): string {
  const version = join(payload, "LIFEOS", "VERSION");
  return existsSync(version) ? readFileSync(version, "utf8").trim() : "unknown";
}

function agentsBlock(version: string, hooks: boolean): string {
  const hookState = hooks ? "LifeOS hooks exported for Codex (experimental)." : "Codex runs without LifeOS hooks.";
  return `${START}
# LifeOS for Codex

## Runtime Contract

- This Codex install uses LifeOS v${version}.
- Canonical doctrine: C:/Users/juanc/.claude/LIFEOS/LIFEOS_SYSTEM_PROMPT.md.
- Codex-local state remains in C:/Users/juanc/.codex/LIFEOS/USER and MEMORY.
- ${hookState}
${END}`;
}

function writeAgentsBlock(codexHome: string, version: string, hooks: boolean, report: Report, apply: boolean): void {
  const target = join(codexHome, "AGENTS.md");
  report.wouldGenerate.push(target);
  if (!apply) return;
  assertWritable(codexHome, target);
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const block = agentsBlock(version, hooks);
  const start = existing.indexOf(START), end = existing.indexOf(END);
  const next = start >= 0 && end >= start
    ? existing.slice(0, start) + block + existing.slice(end + END.length)
    : (existing.trimEnd() ? existing.trimEnd() + "\n\n" : "") + block + "\n";
  writeFileSync(target, next);
}

function writeCodexAgents(codexHome: string, report: Report, apply: boolean): void {
  const target = join(codexHome, "agents.toml");
  report.wouldGenerate.push(target);
  if (!apply) return;
  assertWritable(codexHome, target);
  const marker = "# LifeOS Codex exporter";
  const block = `${marker}
[lifeos]
enabled = true
doctrine = "C:/Users/juanc/.claude/LIFEOS"
`;
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (!existing.includes(marker)) writeFileSync(target, existing.trimEnd() + "\n\n" + block);
}

function backupBeforeMerge(target: string): void {
  if (!existsSync(target)) return;
  cpSync(target, `${target}.bak-${stamp()}`);
}

function mergeCodexConfig(codexHome: string, report: Report, apply: boolean): void {
  for (const name of ["config.toml", "settings.json"]) {
    const target = join(codexHome, name);
    report.protectedUntouched.push(target);
    // Export deliberately never changes these protected runtime files. Hook
    // state is only introduced after the empirical phase-7 experiment.
    void backupBeforeMerge;
    void apply;
  }
}

function syncSkills(payload: string, codexHome: string, report: Report, apply: boolean): void {
  const skills = join(payload, "skills", "LifeOS");
  if (!existsSync(skills)) { report.warnings.push(`missing skill payload: ${skills}`); return; }
  copyTree(skills, join(codexHome, "skills", "LifeOS"), codexHome, report, apply, new Set(["node_modules", ".git"]));
  copyTree(skills, join(homedir(), ".agents", "skills", "LifeOS"), join(homedir(), ".agents"), report, apply, new Set(["node_modules", ".git"]));
}

function syncHooks(payload: string, codexHome: string, report: Report, apply: boolean): void {
  const hooks = join(payload, "hooks");
  if (!existsSync(hooks)) { report.warnings.push(`missing hook payload: ${hooks}`); return; }
  copyTree(hooks, join(codexHome, "hooks"), codexHome, report, apply, new Set(["node_modules", ".git"]));
  report.warnings.push("hooks copied only; hooks.json is intentionally written after the phase-7 probe.");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const payload = join(args.source, "install");
  if (!existsSync(payload)) throw new Error(`LifeOS install payload not found: ${payload}`);
  if (detectDevTree(args.codexHome) && !args.allowDev) throw new Error("refusing to export into a LifeOS development tree; use --allow-dev only for a deliberate test");
  const report: Report = {
    apply: args.apply, mode: args.mode, codexHome: args.codexHome, source: args.source,
    wouldCopy: [], wouldGenerate: [], wouldArchive: [], protectedUntouched: [], warnings: [],
  };
  const lifeos = join(args.codexHome, "LIFEOS");
  if (args.mode === "link") archiveStaleSystemTree(lifeos, args.codexHome, report, args.apply);
  else copyTree(join(payload, "LIFEOS"), lifeos, args.codexHome, report, args.apply);
  if (args.mode === "link" && args.apply) mkdirSync(lifeos, { recursive: true });
  syncSkills(payload, args.codexHome, report, args.apply);
  if (args.withHooks) syncHooks(payload, args.codexHome, report, args.apply);
  writeAgentsBlock(args.codexHome, readVersion(payload), args.withHooks, report, args.apply);
  writeCodexAgents(args.codexHome, report, args.apply);
  mergeCodexConfig(args.codexHome, report, args.apply);
  console.log(JSON.stringify(report, null, 2));
}

try { main(); } catch (error) { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); process.exit(2); }
