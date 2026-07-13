import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const skillRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(skillRoot, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function readSkill(path: string): string {
  return readFileSync(join(skillRoot, path), "utf-8");
}

describe("Windows compatibility guardrails", () => {
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
    expect(rootInstaller).toContain('[string]$FallbackTag = "v6.0.5"');
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
    expect(installHooks).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass -Command");
    expect(installHooks).toContain("$env:CLAUDE_CONFIG_DIR");
    expect(installHooks).toContain("bash.exe");
    expect(installHooks).toContain("bun ${psString(script)}");
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
});
