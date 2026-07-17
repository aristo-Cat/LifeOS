import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveCodexBin(): string | null {
  const fromPath = Bun.which("codex");
  if (fromPath) return fromPath;
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const candidates = [
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "codex.cmd") : "",
    join(home, ".bun", "bin", process.platform === "win32" ? "codex.exe" : "codex"),
  ].filter(Boolean);
  return candidates.find(existsSync) ?? null;
}

export function codexArgv(args: string[]): string[] | null {
  const bin = resolveCodexBin();
  if (!bin) return null;
  return bin.toLowerCase().endsWith(".cmd") ? ["cmd", "/c", bin, ...args] : [bin, ...args];
}
