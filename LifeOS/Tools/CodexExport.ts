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
type Args = { codexHome: string; agentsHome: string; source: string; mode: Mode; apply: boolean; withHooks: boolean; allowDev: boolean };
type Report = {
  apply: boolean; mode: Mode; codexHome: string; source: string;
  wouldCopy: string[]; wouldGenerate: string[]; wouldArchive: string[]; protectedUntouched: string[];
  warnings: string[];
};
type HookCommand = { type: "command"; command: string; timeout?: number; statusMessage?: string };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type HookMap = Record<string, HookGroup[]>;

const PROTECTED = ["auth.json", "history.jsonl", "sessions", "config.toml", "settings.json", "memories", "cache", "installation_id"];
const SYSTEM_EXCLUDES = new Set(["USER", "MEMORY", "node_modules", ".git"]);
const START = "<!-- LIFEOS-CODEX-COMPAT:START -->";
const END = "<!-- LIFEOS-CODEX-COMPAT:END -->";
const CODEX_HOOK_EXCLUDES = ["TabState.hook.ts", "SettingsBackport.ts"];

function parseArgs(argv: string[]): Args {
  const args: Args = {
    codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
    agentsHome: process.env.LIFEOS_AGENTS_HOME || join(homedir(), ".agents"),
    source: resolve(import.meta.dir, ".."),
    mode: "link", apply: false, withHooks: false, allowDev: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--apply") args.apply = true;
    else if (value === "--with-hooks") args.withHooks = true;
    else if (value === "--allow-dev") args.allowDev = true;
    else if (value === "--codex-home") args.codexHome = resolve(argv[++i] || "");
    else if (value === "--agents-home") args.agentsHome = resolve(argv[++i] || "");
    else if (value === "--source") args.source = resolve(argv[++i] || "");
    else if (value === "--mode") {
      const mode = argv[++i];
      if (mode !== "link" && mode !== "copy") throw new Error("--mode must be link or copy");
      args.mode = mode;
    } else if (value === "--help" || value === "-h") {
      console.log("Usage: bun CodexExport.ts [--codex-home <dir>] [--agents-home <dir>] [--source <root>] [--mode link|copy] [--with-hooks] [--apply] [--allow-dev]");
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
      if (excluded.has(entry.name)) continue;
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
- Canonical doctrine is under C:/Users/juanc/.claude/LIFEOS: LIFEOS_SYSTEM_PROMPT.md, DOCUMENTATION/, and ALGORITHM/.
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

function parseAgentFrontmatter(source: string): { name: string; description: string; instructions: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const header = match?.[1] ?? "";
  const field = (name: string): string | null => header.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^['\"]|['\"]$/g, "") ?? null;
  return {
    name: field("name") ?? "LifeOS agent",
    description: field("description") ?? "LifeOS agent exported for Codex.",
    instructions: (match?.[2] ?? source).trim(),
  };
}

function writeCodexAgents(payload: string, codexHome: string, report: Report, apply: boolean): void {
  const sourceDir = join(payload, "agents");
  if (!existsSync(sourceDir)) { report.warnings.push(`missing agent payload: ${sourceDir}`); return; }
  for (const source of readdirSync(sourceDir).filter((name) => name.endsWith(".md"))) {
    const agent = parseAgentFrontmatter(readFileSync(join(sourceDir, source), "utf8"));
    const slug = basename(source, ".md").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
    const codexName = `LifeOS ${slug}`;
    const target = join(codexHome, "agents", `lifeos-${slug}.toml`);
    report.wouldGenerate.push(target);
    if (!apply) continue;
    assertWritable(codexHome, target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, [
      "# Generated by LifeOS CodexExport. Do not edit; change the source agent instead.",
      `name = ${JSON.stringify(codexName)}`,
      `description = ${JSON.stringify(agent.description)}`,
      `developer_instructions = ${JSON.stringify(agent.instructions)}`,
      "",
    ].join("\n"));
  }
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

function syncSkills(payload: string, codexHome: string, agentsHome: string, report: Report, apply: boolean): void {
  const skills = join(payload, "skills", "LifeOS");
  if (!existsSync(skills)) { report.warnings.push(`missing skill payload: ${skills}`); return; }
  copyTree(skills, join(codexHome, "skills", "LifeOS"), codexHome, report, apply, new Set(["node_modules", ".git"]));
  copyTree(skills, join(agentsHome, "skills", "LifeOS"), agentsHome, report, apply, new Set(["node_modules", ".git"]));
}

function codexMatcher(matcher: string | undefined): string | undefined {
  if (!matcher) return undefined;
  const tools = matcher.split("|").flatMap((tool) => ({
    Bash: ["Bash", "shell_command"],
    Write: ["Write", "apply_patch"],
    Edit: ["Edit", "apply_patch"],
    MultiEdit: ["Edit", "apply_patch"],
    Agent: ["Agent", "Task", "multi_tool_use.parallel"],
    WebFetch: ["web.run"],
    WebSearch: ["web.run"],
  }[tool] ?? [tool]));
  return [...new Set(tools)].join("|");
}

function isCodexHookCommand(hook: { type?: string; command?: string }): hook is HookCommand {
  return hook.type === "command" && typeof hook.command === "string" && !CODEX_HOOK_EXCLUDES.some((name) => hook.command.includes(name));
}

function codexHookPath(command: string, codexHome: string): { target: string; args: string[]; shell: boolean } | null {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^['"]|['"]$/g, "")) ?? [];
  if (tokens[0] === "bun") tokens.shift();
  const target = tokens.shift();
  if (!target) return null;
  const mapped = target
    .replace(/^\$HOME\/.claude\/hooks\//, join(codexHome, "hooks") + "/")
    .replace(/^\$HOME\/.claude\/LIFEOS\/TOOLS\//, join(codexHome, "LIFEOS", "TOOLS") + "/")
    .replace(/^~\/.claude\/hooks\//, join(codexHome, "hooks") + "/")
    .replace(/^~\/.claude\/LIFEOS\/TOOLS\//, join(codexHome, "LIFEOS", "TOOLS") + "/");
  return { target: mapped, args: tokens, shell: mapped.endsWith(".sh") };
}

function codexLauncher(codexHome: string): string {
  return `import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const codexHome = ${JSON.stringify(codexHome)};
process.env.HOME ||= process.env.USERPROFILE || homedir();
process.env.CODEX_HOME = codexHome;
process.env.LIFEOS_ENGINE = "codex";
process.env.LIFEOS_TARGET = "codex";
process.env.LIFEOS_RUNTIME_ROOT = codexHome;
process.env.LIFEOS_INSTALL_ROOT = codexHome;
process.env.LIFEOS_DIR = ${JSON.stringify(join(codexHome, "LIFEOS"))};
process.env.CLAUDE_PLUGIN_ROOT = codexHome;
process.env.LIFEOS_SETTINGS_PATH = ${JSON.stringify(join(codexHome, "settings.json"))};

const target = process.argv[2];
if (!target) throw new Error("Codex hook launcher requires a target module");
await import(pathToFileURL(resolve(target)).href);
`;
}

function buildCodexHooks(payload: string, codexHome: string, report: Report): HookMap {
  const source = join(payload, "hooks", "hooks.json");
  const raw = JSON.parse(readFileSync(source, "utf8")) as { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number; async?: boolean }> }>> };
  const launcher = join(codexHome, "hooks", "_codex-env.ts");
  const result: HookMap = {};
  let skipped = 0;
  let downgradedAsync = 0;

  for (const [event, groups] of Object.entries(raw.hooks ?? {})) {
    const mapped = groups.map((group) => {
      const hooks = (group.hooks ?? []).flatMap((hook) => {
        if (!isCodexHookCommand(hook)) { skipped++; return []; }
        const parsed = codexHookPath(hook.command, codexHome);
        if (!parsed) { skipped++; return []; }
        const command = parsed.shell
          ? `bash.exe ${JSON.stringify(parsed.target)} ${parsed.args.map(JSON.stringify).join(" ")}`.trim()
          : `bun run ${JSON.stringify(launcher)} ${JSON.stringify(parsed.target)} ${parsed.args.map(JSON.stringify).join(" ")}`.trim();
        if (hook.async) downgradedAsync++;
        return [{ type: "command" as const, command, timeout: hook.timeout }];
      });
      return hooks.length > 0 ? [{ matcher: codexMatcher(group.matcher), hooks }] : [];
    }).flat();
    if (mapped.length > 0) result[event] = mapped;
  }

  report.warnings.push(`Codex hook export: ${Object.values(result).flatMap((group) => group.flatMap((entry) => entry.hooks)).length} commands generated; ${skipped} Claude-only or unsupported entries omitted.`);
  if (downgradedAsync > 0) report.warnings.push(`Codex hook export: ${downgradedAsync} async hooks downgraded to synchronous because this Codex runtime does not support async hooks.`);
  return result;
}

function syncHooks(payload: string, codexHome: string, report: Report, apply: boolean): void {
  const hooks = join(payload, "hooks");
  if (!existsSync(hooks)) { report.warnings.push(`missing hook payload: ${hooks}`); return; }
  const launcher = join(codexHome, "hooks", "_codex-env.ts");
  const config = join(codexHome, "hooks.json");
  const generated = buildCodexHooks(payload, codexHome, report);
  copyTree(hooks, join(codexHome, "hooks"), codexHome, report, apply, new Set(["node_modules", ".git", "hooks.json"]));
  copyTree(join(payload, "LIFEOS", "TOOLS"), join(codexHome, "LIFEOS", "TOOLS"), codexHome, report, apply);
  report.wouldGenerate.push(launcher, config);
  if (!apply) return;
  assertWritable(codexHome, launcher);
  assertWritable(codexHome, config);
  writeFileSync(launcher, codexLauncher(codexHome));
  writeFileSync(config, `${JSON.stringify({ hooks: generated }, null, 2)}\n`);
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
  syncSkills(payload, args.codexHome, args.agentsHome, report, args.apply);
  if (args.withHooks) syncHooks(payload, args.codexHome, report, args.apply);
  writeAgentsBlock(args.codexHome, readVersion(payload), args.withHooks, report, args.apply);
  writeCodexAgents(payload, args.codexHome, report, args.apply);
  mergeCodexConfig(args.codexHome, report, args.apply);
  console.log(JSON.stringify(report, null, 2));
}

try { main(); } catch (error) { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); process.exit(2); }
