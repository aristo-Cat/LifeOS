import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { classifyTarget, evaluateWrite } from "../install/hooks/lib/system-file-guard-core";

const skillRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(skillRoot, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function readSkill(path: string): string {
  return readFileSync(join(skillRoot, path), "utf-8");
}

function listTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("Windows compatibility guardrails", () => {
  test("path guards are separator-safe", () => {
    const root = "C:\\Users\\Example\\.claude";
    expect(classifyTarget("C:\\Users\\Example\\.claude\\hooks\\guard.ts", root).classification).toBe("system");
    expect(classifyTarget("C:/Users/Example/.claude/LIFEOS/USER/note.md", root).classification).toBe("user");
    expect(classifyTarget("c:\\users\\example\\.claude\\hooks\\guard.ts", root).classification).toBe("system");
    expect(classifyTarget("C:\\tmp\\outside.md", root).classification).toBe("out-of-tree");

    const fixture = mkdtempSync(join(tmpdir(), "lifeos-guard-"));
    const deny = join(fixture, "DENY_LIST.txt");
    writeFileSync(deny, "private-token\n");
    expect(evaluateWrite(`${fixture}\\system.ts`, "private-token", { claudeRoot: fixture, denyListPath: deny }).block).toBe(true);

    const guard = readSkill("install/hooks/lib/system-file-guard-core.ts");
    expect(guard).toContain("isUnder(");
    expect(guard).not.toContain('claudeRoot + "/"');
  });

  test("session hooks avoid POSIX-only process assumptions", () => {
    const sessionHooks = [
      "install/hooks/PromptProcessing.hook.ts",
      "install/hooks/lib/isa-utils.ts",
      "install/hooks/lib/notifications.ts",
      "install/hooks/TaskGovernance.hook.ts",
      "install/hooks/ReminderRouter.hook.ts",
      "install/hooks/lib/tab-setter.ts",
    ].map(readSkill).join("\n");
    expect(sessionHooks).not.toContain("/dev/stdin");
    expect(sessionHooks).not.toContain("tail -200");
    expect(sessionHooks).not.toContain("spawnSync(['find'");
    expect(sessionHooks).not.toContain("/tmp/");
    expect(sessionHooks).not.toContain("command -v");
    expect(sessionHooks).toContain("tmpdir()");
    expect(sessionHooks).toContain("Bun.which('kitten')");
  });

  test("runtime tools resolve HOME, Codex, and macOS-only services safely", () => {
    const codexBin = readSkill("install/LIFEOS/TOOLS/CodexBin.ts");
    expect(codexBin).toContain("resolveCodexBin");
    expect(codexBin).toContain("codexArgv");
    expect(readSkill("install/LIFEOS/TOOLS/ForgeProgress.ts")).toContain("resolveCodexBin");
    expect(readSkill("install/LIFEOS/TOOLS/CrossVendorAudit.ts")).toContain("resolveCodexBin");
    for (const installer of ["InstallBookmarkSweep.ts", "InstallHealthSync.ts", "InstallConveyorRunner.ts", "InstallConveyorWatcher.ts", "InstallWorkSweep.ts", "InstallUsageAggregator.ts", "InstallCodexUpdate.ts", "InstallBlogDiscovery.ts", "InstallCommitmentSweep.ts", "InstallDerivedSync.ts"]) {
      expect(readSkill(`install/LIFEOS/TOOLS/${installer}`)).toContain("launchd is macOS-only");
    }
    expect(readSkill("install/LIFEOS/PULSE/Conduit/InstallConduit.ts")).toContain("launchd is macOS-only");
    expect(readSkill("install/LIFEOS/PULSE/Conduit/InstallConduitInsight.ts")).toContain("launchd is macOS-only");

    const runtimeSources = [
      ...listTypeScriptFiles(join(skillRoot, "install", "LIFEOS", "TOOLS")),
      ...listTypeScriptFiles(join(skillRoot, "install", "hooks", "lib")),
    ].map((path) => readFileSync(path, "utf-8")).join("\n");
    expect(runtimeSources).not.toMatch(/process\.env\.HOME!|process\.env\.HOME \|\| ['\"]{2}|process\.env\.HOME \?\? ['\"]{2}/);

    for (const banner of ["Banner.ts", "BannerMatrix.ts", "BannerNeofetch.ts", "BannerRetro.ts", "NeofetchBanner.ts"]) {
      const source = readSkill(`install/LIFEOS/TOOLS/${banner}`);
      expect(source).toContain("process.stdout.columns");
      expect(source).toContain('process.platform === "win32" ? 80');
    }

    const pulse = readSkill("install/LIFEOS/PULSE/lib.ts");
    expect(pulse).toContain("isWindowsSystemBash");
    expect(pulse).toContain("Git Bash is required on Windows");
  });

  test("CodexExport remains a mirrored, guarded dry-run exporter", () => {
    const exporter = readSkill("Tools/CodexExport.ts");
    expect(readSkill("install/skills/LifeOS/Tools/CodexExport.ts")).toBe(exporter);
    expect(exporter).toContain("LIFEOS-CODEX-COMPAT:START");
    expect(exporter).toContain("--apply");
    expect(exporter).toContain("auth.json");
    expect(exporter).toContain("detectDevTree");
    expect(exporter).toContain("lifeos-${slug}.toml");
    expect(exporter).toContain("developer_instructions");
    expect(exporter).toContain("--with-hooks");
    expect(exporter).toContain("CODEX_HOOK_EXCLUDES");
    expect(exporter).toContain("_codex-env.ts");
    expect(exporter).toContain("commands generated;");
    expect(exporter).toContain("--agents-home");
  });

  test("the Bun statusline is shipped and settings mirrors select it", () => {
    const statusline = readSkill("install/LIFEOS/LIFEOS_StatusLine.ts");
    expect(statusline).toContain("Bun.stdin.text()");
    expect(statusline).toContain("--refresh");
    expect(statusline).not.toContain("execSync(");
    const rootSettings = readSkill("install/settings.system.json");
    const mirroredSettings = readSkill("install/skills/LifeOS/install/settings.system.json");
    expect(rootSettings).toBe(mirroredSettings);
    expect(rootSettings).toContain('bun \\"$HOME/.claude/LIFEOS/LIFEOS_StatusLine.ts\\"');
  });

  test("repo and payload expose native PowerShell installers", () => {
    expect(existsSync(join(repoRoot, "install.ps1"))).toBe(true);
    expect(existsSync(join(repoRoot, "install.cmd"))).toBe(true);
    expect(existsSync(join(skillRoot, "install", "install.ps1"))).toBe(true);
    expect(existsSync(join(skillRoot, "install", "skills", "LifeOS", "install", "install.ps1"))).toBe(true);

    const rootInstaller = read("install.ps1");
    expect(rootInstaller).toContain('[ValidateSet("claude", "codex", "both")]');
    expect(rootInstaller).toContain('[string]$Target = "claude"');
    expect(rootInstaller).toContain('[string]$Version = ""');
    expect(rootInstaller).toContain('[string]$Ref = "windows-compat-v6"');
    expect(rootInstaller).toContain('[string]$FallbackTag = "v7.1.1-win"');
    expect(rootInstaller).toContain("releases/latest");
    expect(rootInstaller).toContain("archive/refs/heads/$Ref.zip");
    expect(rootInstaller).not.toContain('[string]$Version = "6.0.3"');
    expect(rootInstaller).toContain("CODEX_HOME");
    expect(rootInstaller).toContain("LIFEOS-CODEX-COMPAT:START");

    const payloadInstaller = readSkill("install/install.ps1");
    expect(payloadInstaller).toContain('[ValidateSet("claude", "codex", "both")]');
    expect(payloadInstaller).toContain("Update-CodexAgentsFile");
    expect(payloadInstaller).toContain("LIFEOS-CODEX-COMPAT:START");
  });

  test("InstallEngine detects Windows and Codex without Unix shell assumptions", () => {
    const engine = readSkill("Tools/InstallEngine.ts");
    expect(engine).toContain('"codex"');
    expect(engine).toContain("CODEX_HOME");
    expect(engine).toContain("where ${name}");
    expect(engine).toContain('os.platform === "darwin" || os.platform === "windows"');
    expect(engine).toContain('symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir")');
    expect(engine).toContain('"copied-fallback"');
    expect(engine).toContain(".lifeos-user-copy-fallback.json");
  });

  test("Windows Pulse and statusline assets are shipped and wired", () => {
    expect(existsSync(join(skillRoot, "install", "LIFEOS", "LIFEOS_StatusLine.ps1"))).toBe(true);
    expect(existsSync(join(skillRoot, "install", "LIFEOS", "PULSE", "manage.ps1"))).toBe(true);

    const components = readSkill("Tools/DeployComponents.ts");
    expect(components).toContain("deployPulseWindows");
    expect(components).toContain("manage.ps1");
    expect(components).toContain("LIFEOS_StatusLine.ps1");
    expect(components).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass -File");
    // v7.1.1 merge: launchd moved to Services.ts (macOS-only). Windows short-circuits
    // deploy(): pulse -> deployPulseWindows, every other launchd service skipped.
    expect(components).toContain('if (ctx.platform === "win32")');
    expect(components).toContain('component === "pulse") return deployPulseWindows(ctx)');
    expect(components).toContain("launchd unavailable on ${ctx.platform}");

    const pulseManager = readSkill("install/LIFEOS/PULSE/manage.ps1");
    expect(pulseManager).toContain("Register-ScheduledTask");
    expect(pulseManager).toContain("Install-StartupFallback");
    expect(pulseManager).toContain("System.Net.Sockets.TcpClient");
    expect(pulseManager).toContain("bun install");
  });

  test("Claude Code hooks are normalized for Windows instead of using POSIX $HOME commands", () => {
    const installHooks = readSkill("Tools/InstallHooks.ts");
    expect(installHooks).toContain("normalizeHooksForPlatform");
    expect(installHooks).toContain("toWindowsHookCommand");
    expect(installHooks).toContain("bash.exe");
    expect(installHooks).toContain("winString(script)");
    // Regression (2026-07-16): the harness runs hook commands through Git Bash on
    // Windows. A `powershell.exe -Command "<script>"` wrapper never survived it —
    // bash stripped the double quotes and expanded the `$` first, so powershell saw
    // `:HOME` for `$env:HOME` and `if ()` for `if ($bash)`, and every wrapped hook
    // died with a ParserError (47 of 58 wirings dead). The runner is emitted
    // directly now; HOME/LIFEOS_DIR arrive via the settings.json `env` block.
    expect(installHooks).not.toContain("-ExecutionPolicy Bypass -Command");
    expect(installHooks).not.toContain("$env:HOME =");
    expect(installHooks).not.toContain("$env:CLAUDE_CONFIG_DIR =");
    // Update-path hygiene: --prune removes LifeOS hook artifacts upstream retired,
    // scoped so it never deletes a user's own files.
    expect(installHooks).toContain("--prune");
    expect(installHooks).toContain("pruneScan");
    expect(installHooks).toContain("stripStaleWiring");
    expect(installHooks).toContain("isLifeosHookArtifact");
  });

  test("packaged LifeOS skill mirrors the updated installer tools and docs", () => {
    expect(readSkill("install/skills/LifeOS/Tools/InstallEngine.ts")).toBe(readSkill("Tools/InstallEngine.ts"));
    expect(readSkill("install/skills/LifeOS/Tools/DeployComponents.ts")).toBe(readSkill("Tools/DeployComponents.ts"));
    expect(readSkill("install/skills/LifeOS/Tools/InstallHooks.ts")).toBe(readSkill("Tools/InstallHooks.ts"));
    expect(readSkill("install/skills/LifeOS/Tools/InstallSettings.ts")).toBe(readSkill("Tools/InstallSettings.ts"));
    expect(readSkill("install/skills/LifeOS/Tools/ActivateImports.ts")).toBe(readSkill("Tools/ActivateImports.ts"));
    expect(readSkill("install/skills/LifeOS/Tools/ScaffoldUser.ts")).toBe(readSkill("Tools/ScaffoldUser.ts"));
    expect(readSkill("install/skills/LifeOS/Tools/LinkUser.ts")).toBe(readSkill("Tools/LinkUser.ts"));
    expect(readSkill("install/skills/LifeOS/Tools/SeedPulse.ts")).toBe(readSkill("Tools/SeedPulse.ts"));
    expect(readSkill("install/skills/LifeOS/INSTALL.md")).toBe(readSkill("INSTALL.md"));
    expect(readSkill("install/skills/LifeOS/Workflows/Setup.md")).toBe(readSkill("Workflows/Setup.md"));
    expect(readSkill("install/skills/LifeOS/install/install.ps1")).toBe(readSkill("install/install.ps1"));
    expect(readSkill("INSTALL.md")).toContain("CodexExport.ts --with-hooks");
    expect(readSkill("Workflows/Setup.md")).toContain("Codex-native `hooks.json` arrays");
  });

  test("v7.1.1 new files resolve HOME and PATH the Windows way", () => {
    // BLOCKER #1: InstallSettings resolves a real home, never "" (an empty home
    // shipped a literal $HOME/.claude into settings.json — the #1404/#1451 shadow dir).
    const installSettings = readSkill("Tools/InstallSettings.ts");
    expect(installSettings).toContain("process.env.HOME || process.env.USERPROFILE || homedir()");
    expect(installSettings).not.toContain('process.env.HOME || ""');

    // BLOCKER #2: the statusline .ps1 hands bash an MSYS path, or the fail-closed
    // guard (#1463) collapses the line to bare "LifeOS".
    const statusPs1 = readSkill("install/LIFEOS/LIFEOS_StatusLine.ps1");
    expect(statusPs1).toContain("ConvertTo-MsysPath");
    expect(statusPs1).toContain("$env:LIFEOS_DIR = ConvertTo-MsysPath");
    expect(statusPs1).toContain("$env:HOME = ConvertTo-MsysPath");

    // Doctor: PATH probe + Chrome discovery are Windows-aware.
    const doctor = readSkill("install/LIFEOS/TOOLS/Doctor.ts");
    expect(doctor).toContain("Bun.which(bin)");
    expect(doctor).toContain("chrome.exe");
    expect(doctor).toContain("process.env.HOME || process.env.USERPROFILE || homedir()");

    // CarrierProbe: slug covers drive-colon + backslashes (verified vs the real
    // ~/.claude/projects dir name), claude.exe resolves for shell-less spawn, and
    // CLAUDE_CONFIG_DIR is honored — else the probe is always INCONCLUSIVE / ENOENT.
    const carrier = readSkill("install/LIFEOS/TOOLS/CarrierProbe.ts");
    expect(carrier).toContain("C--Users-juanc--claude");
    expect(carrier).toContain("where claude");
    expect(carrier).toContain("process.env.CLAUDE_CONFIG_DIR || join(homedir()");

    // MemoryHealthCheck runs every turn — an empty HOME would nag CRITICAL.
    const memHealth = readSkill("install/LIFEOS/TOOLS/MemoryHealthCheck.ts");
    expect(memHealth).toContain("process.env.HOME || process.env.USERPROFILE || homedir()");
    expect(memHealth).not.toContain('process.env.HOME || ""');
  });

  test("hooks/lib modules imported by CLI tools resolve HOME without the hook wrapper", () => {
    // These two live under hooks/ but are imported by tools that run outside
    // InstallHooks' PowerShell prelude (lifeos, MemoryStatus, WorkSweep, UpdateTelos,
    // the sweeps, PULSE), so they cannot lean on $env:HOME being set for them.
    const identity = readSkill("install/hooks/lib/identity.ts");
    expect(identity).toContain("process.env.HOME || process.env.USERPROFILE || homedir()");
    expect(identity).not.toContain("process.env.HOME!");
    expect(identity).toContain('import { homedir } from');

    const workConfig = readSkill("install/hooks/lib/work-config.ts");
    expect(workConfig).toContain("process.env.HOME || process.env.USERPROFILE || homedir()");
    expect(workConfig).not.toContain('const HOME = process.env.HOME || ""');
    expect(workConfig).toContain('import { homedir } from');
  });
});
