#!/usr/bin/env bun
/**
 * InstallHooks — Setup step 7 (trust-gated). Additively merges the payload's
 * `install/hooks/hooks.json` into the harness `settings.json`: per matcher
 * bucket, idempotent by normalized command (and url for http entries), never
 * touching foreign entries. Backs up settings.json before writing. REFUSES on a
 * dev tree (the author's live source) unless --allow-dev.
 *
 * The skill's Setup workflow shows the user the exact change (from the dry-run
 * counts) and gets explicit permission BEFORE calling this with --apply.
 *
 * Usage:
 *   bun InstallHooks.ts [--config-root <dir>] [--skill-root <dir>] [--apply] [--allow-dev]
 *   (dry-run by default — reports added/skipped without writing)
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectDevTree, mergeHooks } from "./InstallEngine";

interface Args { configRoot: string; skillRoot: string; apply: boolean; allowDev: boolean; }
type HookEntry = { type?: string; command?: string; url?: string; [k: string]: unknown };
type MatcherGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type HooksMap = Record<string, MatcherGroup[]>;

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
  };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return {
    configRoot: get("--config-root") || process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    skillRoot: get("--skill-root") || join(import.meta.dir, ".."),
    apply: a.includes("--apply"),
    allowDev: a.includes("--allow-dev"),
  };
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function splitCommandArgs(segment: string): string[] {
  const matches = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ""));
}

function resolveInstallPath(token: string, configRoot: string): string {
  return token
    .replace(/^\$HOME\/\.claude(?=\/|$)/, configRoot.replace(/\\/g, "/"))
    .replace(/^~\/\.claude(?=\/|$)/, configRoot.replace(/\\/g, "/"))
    .replace(/\//g, "\\");
}

function windowsBunSegment(segment: string, configRoot: string): string {
  const parts = splitCommandArgs(segment.trim());
  if (parts[0] === "bun") parts.shift();
  if (parts.length === 0) return "";

  const script = resolveInstallPath(parts[0], configRoot);
  const args = parts.slice(1).map((arg) => resolveInstallPath(arg, configRoot));
  if (script.endsWith(".sh")) {
    return [
      "$bash = Get-Command bash.exe -ErrorAction SilentlyContinue",
      `if ($bash) { & $bash.Source ${psString(script)} ${args.map(psString).join(" ")} }`,
    ].join("; ");
  }
  return `bun ${psString(script)} ${args.map(psString).join(" ")}`.trim();
}

function toWindowsHookCommand(command: string, configRoot: string): string {
  const segments = command.split(";").map((part) => windowsBunSegment(part, configRoot)).filter(Boolean);
  const prelude = [
    `$env:HOME = ${psString(process.env.HOME || process.env.USERPROFILE || homedir())}`,
    `$env:CLAUDE_CONFIG_DIR = ${psString(configRoot)}`,
    `$env:LIFEOS_DIR = ${psString(join(configRoot, "LIFEOS"))}`,
  ];
  const script = [...prelude, ...segments].join("; ");
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ${JSON.stringify(script)}`;
}

function normalizeHooksForPlatform(hooks: HooksMap, configRoot: string): HooksMap {
  if (process.platform !== "win32") return hooks;
  const cloned = JSON.parse(JSON.stringify(hooks)) as HooksMap;
  for (const groups of Object.values(cloned)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook.type === "command" && typeof hook.command === "string") {
          hook.command = toWindowsHookCommand(hook.command, configRoot);
        }
      }
    }
  }
  return cloned;
}

function countFilesRec(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) n += countFilesRec(p);
    else n += 1;
  }
  return n;
}

function main(): void {
  const { configRoot, skillRoot, apply, allowDev } = parseArgs();

  if (detectDevTree(configRoot) && !allowDev) {
    console.log(JSON.stringify({ ok: false, refused: "dev-tree", detail: `${configRoot} is a LifeOS source tree (skills/_LIFEOS present) — refusing to mutate. Use --allow-dev only in a sandbox.` }, null, 2));
    process.exit(2);
  }

  const hooksJsonPath = join(skillRoot, "install", "hooks", "hooks.json");
  if (!existsSync(hooksJsonPath)) {
    console.log(JSON.stringify({ ok: false, error: `payload hooks.json not found at ${hooksJsonPath}` }, null, 2));
    process.exit(1);
  }
  const rawIncoming = JSON.parse(readFileSync(hooksJsonPath, "utf-8"))?.hooks ?? {};
  const incoming = normalizeHooksForPlatform(rawIncoming, configRoot);

  // The hook SCRIPTS (*.hook.ts|sh + lib/**) live beside hooks.json in the payload.
  // Merging hooks.json into settings.json wires commands that point at these files,
  // so they MUST be copied onto disk too — else every hook resolves to a nonexistent
  // file (audit 20260702, RC2). Kept atomic with the settings merge (same opt-in +
  // trust-gate): decline hooks → neither scripts nor settings entries land.
  const hooksPayloadDir = join(skillRoot, "install", "hooks");
  const hooksDestDir = join(configRoot, "hooks");
  const hookFiles = countFilesRec(hooksPayloadDir);

  const settingsPath = join(configRoot, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }
  const existingHooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<string, never>;

  const { merged, added, skipped } = mergeHooks(existingHooks as never, incoming);

  const report = { ok: true, apply, settingsPath, added, skipped, events: Object.keys(merged).length, hooksDestDir, hookFiles };

  if (!apply) {
    console.log(JSON.stringify({ ...report, dryRun: true, note: "no changes written; re-run with --apply after permission" }, null, 2));
    process.exit(0);
  }

  // Back up settings.json before writing (only if it exists).
  let backup: string | undefined;
  if (existsSync(settingsPath)) {
    backup = `${settingsPath}.lifeos-backup-${Date.now()}`;
    copyFileSync(settingsPath, backup);
  }
  settings.hooks = merged;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // Deploy the hook scripts next to the merged settings (RC2): recursive copy of
  // the whole payload hooks/ tree (*.hook.ts|sh + lib/**) into <configRoot>/hooks/.
  mkdirSync(hooksDestDir, { recursive: true });
  cpSync(hooksPayloadDir, hooksDestDir, { recursive: true });
  const hookFilesCopied = countFilesRec(hooksDestDir);

  console.log(JSON.stringify({ ...report, written: true, backup, hookFilesCopied }, null, 2));
  process.exit(0);
}

main();
