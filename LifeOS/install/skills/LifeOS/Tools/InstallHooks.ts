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
 *   bun InstallHooks.ts [--config-root <dir>] [--skill-root <dir>] [--apply] [--allow-dev] [--prune]
 *   (dry-run by default — reports added/skipped without writing)
 *
 * --prune (update path): after copying the current hook tree, delete LifeOS hook
 *   artifacts left in <configRoot>/hooks/ that upstream retired, and strip their
 *   now-dangling settings.json wiring. Dry-run reports orphans; --apply removes them.
 *   Scoped to LifeOS-owned artifacts (*.hook.ts|sh, handlers/**, lib/**) — never a
 *   user's own files.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { detectDevTree, mergeHooks } from "./InstallEngine";

interface Args { configRoot: string; skillRoot: string; apply: boolean; allowDev: boolean; prune: boolean; }
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
    prune: a.includes("--prune"),
  };
}

// ── Update-path hygiene (--prune) ────────────────────────────────────────────
// cpSync + mergeHooks are ADDITIVE: an in-place update copies the current hook
// tree over the old one and merges hooks.json into settings.json, but never
// removes hook artifacts retired upstream (v7 dropped ~20). --prune reconciles
// <configRoot>/hooks/ and the settings.json wiring down to the current payload,
// scoped to LifeOS-owned artifacts only (never a user's own files).

function listFilesRec(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFilesRec(p, base));
    else out.push(relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

/** A file LifeOS ships under hooks/ — the only class --prune is allowed to delete. */
function isLifeosHookArtifact(rel: string): boolean {
  return /\.hook\.(ts|sh)$/.test(rel) || rel.startsWith("handlers/") || rel.startsWith("lib/");
}

/** Orphans = LifeOS hook artifacts present in the live tree but absent from the payload. */
function pruneScan(payloadDir: string, destDir: string): { orphanFiles: string[]; orphanBasenames: string[] } {
  const payloadRel = new Set(listFilesRec(payloadDir));
  const orphanFiles = listFilesRec(destDir).filter((rel) => isLifeosHookArtifact(rel) && !payloadRel.has(rel));
  const orphanBasenames = [...new Set(orphanFiles.map((rel) => rel.split("/").pop() as string))];
  return { orphanFiles, orphanBasenames };
}

/** Drop settings.json hook entries whose command references an orphaned hook file;
 * remove now-empty matcher groups. Mutates `hooks` in place; returns entries removed. */
function stripStaleWiring(hooks: HooksMap, orphanBasenames: string[]): number {
  if (orphanBasenames.length === 0) return 0;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => {
        const cmd = typeof h.command === "string" ? h.command : "";
        return !orphanBasenames.some((b) => cmd.includes(b));
      });
      removed += before - group.hooks.length;
    }
    hooks[event] = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
  }
  return removed;
}

function winString(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
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
  const runner = script.endsWith(".sh") ? "bash.exe" : "bun";
  return `${runner} ${winString(script)} ${args.map(winString).join(" ")}`.trim();
}

// The harness runs hook commands through Git Bash on Windows, so a
// `powershell.exe -Command "..."` wrapper is destroyed before powershell ever
// parses it: bash strips the double quotes and expands the `$`, turning
// `$env:HOME` into `:HOME` and `if ($bash)` into `if ()` (ParserError). Emit the
// runner directly instead. HOME/LIFEOS_DIR reach the hook process via the `env`
// block in settings.json, which the harness injects into hook subprocesses.
function toWindowsHookCommand(command: string, configRoot: string): string {
  return command
    .split(";")
    .map((part) => windowsBunSegment(part, configRoot))
    .filter(Boolean)
    .join("; ");
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
  const { configRoot, skillRoot, apply, allowDev, prune } = parseArgs();

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

  // --prune (update-path hygiene): scan for orphaned hook artifacts and strip their
  // stale settings.json wiring from `merged` (files are deleted after cpSync, below).
  const orphans = prune ? pruneScan(hooksPayloadDir, hooksDestDir) : { orphanFiles: [] as string[], orphanBasenames: [] as string[] };
  const staleWiring = prune ? stripStaleWiring(merged as HooksMap, orphans.orphanBasenames) : 0;

  const report = { ok: true, apply, settingsPath, added, skipped, events: Object.keys(merged).length, hooksDestDir, hookFiles, ...(prune ? { prune: { orphanFiles: orphans.orphanFiles, staleWiring } } : {}) };

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

  // --prune: delete the orphaned hook files (their settings wiring is already gone
  // from `merged`, written above). Scoped to LifeOS artifacts by pruneScan.
  let prunedFiles = 0;
  if (prune) {
    for (const rel of orphans.orphanFiles) {
      try { rmSync(join(hooksDestDir, rel), { force: true }); prunedFiles++; } catch { /* best effort */ }
    }
  }
  const hookFilesCopied = countFilesRec(hooksDestDir);

  console.log(JSON.stringify({ ...report, written: true, backup, hookFilesCopied, ...(prune ? { prunedFiles } : {}) }, null, 2));
  process.exit(0);
}

main();
