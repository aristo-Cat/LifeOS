#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════════════════
// LifeOS Status Line — single-process Bun renderer.
//
// Windows path for LIFEOS_StatusLine.sh. The bash renderer forks ~110 external
// binaries (tr/jq/wc/sed/cat/head/git/date); at ~231 ms per fork on Windows that
// is 6-20 s per render, and Claude Code cancels any in-flight statusline on the
// next refresh tick (min 1 s) — so it never finished and the line stayed blank.
// This renders the same content with zero forks: native fs + fetch.
//
// The .sh stays canonical on macOS/Linux. Keep the two in sync by eye; the render
// contract (order, colors, glyphs) is duplicated here deliberately.
//
// Three deliberate deviations from the .sh, all cases where bash is WRONG on
// Windows rather than places this port drifts:
//   1. Memory review age: .sh uses `date -u -j -f` (BSD-only), which fails under
//      GNU/Windows date and falls back to now => always "0M AGO". Computed here.
//   2. Reset times: .sh runs `TZ=$USER_TZ date`, but git-bash on Windows ships no
//      tzdata, so any IANA zone silently degrades to UTC (reset showed 0930 for a
//      11:30 Madrid reset). Uses Intl (ICU) here.
//   3. "Today" for TODAY@HHMM: same tzdata cause as (2).
//
// Refresh policy: location/weather/usage all refresh stale-while-revalidate in a
// detached `--refresh` child, so the render path never awaits the network. The .sh
// fetches usage synchronously on the render path (a 15-min tick that risks a 3 s
// stall); this port never blocks.
// ═══════════════════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// PATHS & CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || homedir();
const TMP = tmpdir();

function expandHome(p: string): string {
  return p
    .replace(/^\$\{HOME\}/, HOME)
    .replace(/^\$HOME/, HOME)
    .replace(/^~\//, HOME + "/");
}

const LIFEOS_DIR = expandHome(process.env.LIFEOS_DIR || join(HOME, ".claude", "LIFEOS"));

// Fail closed, same contract as the .sh: an unexpanded or relative LIFEOS_DIR
// would scatter cache writes relative to CWD. Print the bare word and leave.
if (!isAbsolute(LIFEOS_DIR) || /\$HOME|\$\{HOME\}|~/.test(LIFEOS_DIR)) {
  process.stdout.write("LifeOS\n");
  process.exit(0);
}

const CLAUDE_HOME = join(HOME, ".claude");
const SETTINGS_FILE = join(CLAUDE_HOME, "settings.json");
const QUOTES_FILE = join(LIFEOS_DIR, "USER", "PRINCIPAL", "Quotes.txt");
const LOCATION_CACHE = join(LIFEOS_DIR, "MEMORY", "STATE", "location-cache.json");
const WEATHER_CACHE = join(LIFEOS_DIR, "MEMORY", "STATE", "weather-cache.json");
const MODEL_CACHE = join(LIFEOS_DIR, "MEMORY", "STATE", "model-cache.txt");
// `${USER:-anon}` in the .sh — on Windows USER is unset, so this resolves to
// "anon" and shares the exact cache file git-bash writes. Do NOT swap in
// USERNAME: that would fork a second, unshared cache.
const USAGE_CACHE = join(TMP, `pai-usage-${process.env.USER || "anon"}.json`);
const USAGE_LOCK = join(TMP, `pai-usage-${process.env.USER || "anon"}.lock`);
const LOCWX_LOCK = join(TMP, "pai-locwx-refresh.lock");

const LOCATION_CACHE_TTL = 3600;
const WEATHER_CACHE_TTL = 900;
const USAGE_CACHE_TTL = 900;
const USAGE_HARD_EXPIRY = 21600;

const NOW_EPOCH = Math.floor(Date.now() / 1000);

// ─────────────────────────────────────────────────────────────────────────────
// TINY FS HELPERS (never throw — a statusline must not crash the prompt)
// ─────────────────────────────────────────────────────────────────────────────

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function readJSON<T = any>(p: string): T | null {
  const t = readText(p);
  if (!t) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

function fileBytes(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function mtime(p: string): number {
  try {
    return Math.floor(statSync(p).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function lastLine(p: string): string {
  const t = readText(p);
  if (!t) return "";
  const lines = t.split("\n").filter((l) => l.trim().length > 0);
  return lines.length ? lines[lines.length - 1] : "";
}

/** `tr '[:lower:]' '[:upper:]'` in the C locale: ASCII only, never Unicode. */
function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** Integer division matching bash $(( a / b )) — truncates toward zero. */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** `${var%%.*}` on a numeric string, then default 0. */
function intPart(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const s = String(v);
  const cut = s.includes(".") ? s.slice(0, s.indexOf(".")) : s;
  const n = parseInt(cut, 10);
  return Number.isFinite(n) ? n : 0;
}

function globFiles(dir: string, match: (name: string) => boolean): string[] {
  try {
    return readdirSync(dir)
      .filter(match)
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COLORS — byte-for-byte the .sh palette
// ─────────────────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const SLATE_300 = "\x1b[38;2;203;213;225m";
const SLATE_400 = "\x1b[38;2;148;163;184m";
const SLATE_500 = "\x1b[38;2;100;116;139m";
const SLATE_600 = "\x1b[38;2;71;85;105m";
const EMERALD = "\x1b[38;2;74;222;128m";
const ROSE = "\x1b[38;2;251;113;133m";
const RATING_10 = "\x1b[38;2;74;222;128m";
const RATING_8 = "\x1b[38;2;163;230;53m";
const RATING_7 = "\x1b[38;2;250;204;21m";
const RATING_6 = "\x1b[38;2;251;191;36m";
const RATING_5 = "\x1b[38;2;251;146;60m";
const RATING_4 = "\x1b[38;2;248;113;113m";
const RATING_LOW = "\x1b[38;2;239;68;68m";
const WIELD_ACCENT = "\x1b[38;2;103;232;249m";
const CTX_SECONDARY = "\x1b[38;2;165;180;252m";
const CTX_BUCKET_EMPTY = "\x1b[38;2;75;82;95m";
const USAGE_PRIMARY = "\x1b[38;2;194;139;62m";
const USAGE_LABEL = "\x1b[38;2;168;113;50m";
const USAGE_RESET_C = "\x1b[38;2;148;163;184m";
const USAGE_EXTRA = "\x1b[38;2;140;90;60m";
const USAGE_EXTRA_ACTIVE = "\x1b[38;2;251;146;60m";
const USAGE_STALE = "\x1b[38;2;120;113;108m";
const QUOTE_AUTHOR = "\x1b[38;2;180;140;60m";
const LIFEOS_P = "\x1b[38;2;37;99;235m";
const LIFEOS_A = "\x1b[38;2;59;130;246m";
const LIFEOS_I = "\x1b[38;2;147;197;253m";
const LIFEOS_CITY = "\x1b[38;2;37;99;235m";
const LIFEOS_STATE_C = "\x1b[38;2;125;211;252m";
const LIFEOS_TIME = "\x1b[38;2;96;165;250m";
const LIFEOS_WEATHER = "\x1b[38;2;135;206;235m";
const LIFEOS_SESSION = "\x1b[38;2;120;135;160m";
const LIFEOS_LOGO = ""; // Pulse waveform (Hack Nerd Font)
const CTX_PCT_GREEN = "\x1b[38;2;22;163;74m";
const MEM_SAGE = "\x1b[38;2;167;184;148m";
const GIT_PRIMARY = "\x1b[38;2;56;189;248m";
const GIT_VALUE = "\x1b[38;2;186;230;253m";
const GIT_STASH = "\x1b[38;2;165;180;252m";
const GIT_AGE_RECENT = "\x1b[38;2;96;165;250m";
const LEARN_PRIMARY = "\x1b[38;2;167;139;250m";
const LEARN_WORK = "\x1b[38;2;192;132;252m";
const LEARN_SIGNALS = "\x1b[38;2;139;92;246m";
const LEARN_SESSIONS = "\x1b[38;2;99;102;241m";
const LEARN_LABEL = "\x1b[38;2;21;128;61m";
const CTX_PRIMARY = "\x1b[38;2;129;140;248m";

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

const settings: any = readJSON(SETTINGS_FILE) || {};
let TEMP_UNIT: string = settings?.preferences?.temperatureUnit || "fahrenheit";
if (TEMP_UNIT !== "celsius") TEMP_UNIT = "fahrenheit";
const USER_TZ: string = settings?.principal?.timezone || process.env.TZ || "UTC";
const LOC_CITY: string = settings?.location?.city || "";
const LOC_REGION: string = settings?.location?.regionName || "";
const LOC_LAT = settings?.location?.lat ?? "";
const LOC_LON = settings?.location?.lon ?? "";
const LOC_CC: string = settings?.location?.countryCode || "";

const LIFEOS_VERSION = (readText(join(LIFEOS_DIR, "VERSION")).trim() || "—");
const ALGO_VERSION = (readText(join(LIFEOS_DIR, "ALGORITHM", "LATEST")).trim() || "—");

// ─────────────────────────────────────────────────────────────────────────────
// TIME (ICU-backed — the tzdata the .sh lacks on Windows)
// ─────────────────────────────────────────────────────────────────────────────

function tzParts(epoch: number, tz: string): { ymd: string; hhmm: string; dow: number } {
  const d = new Date(epoch * 1000);
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
  }
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = get("hour");
  if (hour === "24") hour = "00"; // en-CA h23/h24 edge
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    hhmm: `${hour}${get("minute")}`,
    dow: dowMap[get("weekday")] ?? 0,
  };
}

/** Unix epoch ints pass through; ISO 8601 strings parse via Date. */
function parseIsoEpoch(ts: unknown): number {
  if (ts === null || ts === undefined || ts === "") return 0;
  const s = String(ts);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** "TODAY@1500" / "THU@0900" / "now" — in the principal's real timezone. */
function resetTimeStr(epoch: number): string {
  if (!epoch || epoch <= 0) return "now";
  if (epoch <= NOW_EPOCH) return "now";
  const r = tzParts(epoch, USER_TZ);
  const today = tzParts(NOW_EPOCH, USER_TZ).ymd;
  if (r.ymd === today) return `TODAY@${r.hhmm}`;
  const names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return `${names[r.dow] || "NOW"}@${r.hhmm}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STDIN
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_MODE = process.argv.includes("--refresh");

let input: any = {};
if (!REFRESH_MODE) {
  try {
    const raw = await Bun.stdin.text();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
}

const current_dir: string = input?.workspace?.current_dir || input?.cwd || ".";
const session_id: string = input?.session_id || "";
const model_name: string = input?.model?.display_name || "unknown";
const effort_level: string = input?.effort?.level || "";
const output_style: string = input?.output_style?.name || "";
const cc_version_json: string = input?.version || "";
const harness_name_json: string = input?.harness?.name || "";
const harness_version_json: string = input?.harness?.version || "";
const context_max: number = input?.context_window?.context_window_size ?? 200000;
const total_input: number = input?.context_window?.total_input_tokens ?? 0;

const rl = input?.rate_limits;
const has_native_rate_limits = rl != null;
const native_5h_val = rl?.five_hour?.used_percentage ?? rl?.five_hour?.utilization;
const native_7d_val = rl?.seven_day?.used_percentage ?? rl?.seven_day?.utilization;
const native_usage_5h_present = native_5h_val != null;
const native_usage_7d_present = native_7d_val != null;

// ─────────────────────────────────────────────────────────────────────────────
// DETACHED REFRESH (`--refresh`): the only place the network is touched.
// ─────────────────────────────────────────────────────────────────────────────

/** Atomic mkdir lock, mirroring the .sh mutex. Returns false if held. */
function acquireLock(dir: string, staleAfter: number): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch {
    const age = NOW_EPOCH - mtime(dir);
    if (age > staleAfter) {
      try {
        rmdirSync(dir);
        mkdirSync(dir);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function releaseLock(dir: string) {
  try {
    rmdirSync(dir);
  } catch {
    /* not ours to clear */
  }
}

const WMO_ICON = (code: number, isDay: boolean): string => {
  if (code === 0) return isDay ? "☀️" : "🌙";
  if (code === 1 || code === 2) return isDay ? "🌤️" : "☁️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "🌨️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
};

async function refreshLocationWeather() {
  const locAge = exists(LOCATION_CACHE) ? NOW_EPOCH - mtime(LOCATION_CACHE) : 999999;
  const wxAge = exists(WEATHER_CACHE) ? NOW_EPOCH - mtime(WEATHER_CACHE) : 999999;
  if (locAge <= LOCATION_CACHE_TTL && wxAge <= WEATHER_CACHE_TTL) return;
  if (!acquireLock(LOCWX_LOCK, 30)) return;
  try {
    // Configured location wins over IP geolocation: correct behind VPN, and one
    // fewer third party seeing the principal's IP.
    if (LOC_CITY) {
      writeFileSync(
        LOCATION_CACHE,
        JSON.stringify({
          city: LOC_CITY,
          regionName: LOC_REGION,
          countryCode: LOC_CC,
          lat: LOC_LAT === "" ? null : Number(LOC_LAT),
          lon: LOC_LON === "" ? null : Number(LOC_LON),
        }),
      );
    } else if (locAge > LOCATION_CACHE_TTL) {
      try {
        const res = await fetch(
          "http://ip-api.com/json/?fields=city,region,regionName,country,countryCode,lat,lon",
          { signal: AbortSignal.timeout(3000) },
        );
        const data: any = await res.json();
        if (data?.city) writeFileSync(LOCATION_CACHE, JSON.stringify(data));
      } catch {
        /* keep last known good */
      }
    }

    if (wxAge > WEATHER_CACHE_TTL && exists(LOCATION_CACHE)) {
      const loc: any = readJSON(LOCATION_CACHE);
      if (loc?.lat != null && loc?.lon != null) {
        try {
          const res = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
              `&current=temperature_2m,weather_code,is_day&temperature_unit=${TEMP_UNIT}`,
            { signal: AbortSignal.timeout(4000) },
          );
          const wx: any = await res.json();
          if (wx?.current) {
            const t = intPart(wx.current.temperature_2m);
            const icon = WMO_ICON(Number(wx.current.weather_code), Number(wx.current.is_day) === 1);
            writeFileSync(WEATHER_CACHE, `${icon} ${t}°${TEMP_UNIT === "celsius" ? "C" : "F"}\n`);
          }
        } catch {
          /* keep last known good */
        }
      }
    }
  } finally {
    releaseLock(LOCWX_LOCK);
  }
}

async function refreshUsage() {
  let dataAge = 999999;
  const cached: any = readJSON(USAGE_CACHE);
  if (cached) {
    const f = cached.fetched_at;
    dataAge = typeof f === "number" ? NOW_EPOCH - f : NOW_EPOCH - mtime(USAGE_CACHE);
  }
  if (dataAge <= USAGE_CACHE_TTL) return;
  if (!acquireLock(USAGE_LOCK, 15)) return;
  try {
    // macOS keeps the token in Keychain (`security find-generic-password`);
    // everywhere else it is this file. No Keychain path on Windows.
    const creds: any = readJSON(join(HOME, ".claude", ".credentials.json"));
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) return;
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(3000),
    });
    const body: any = await res.json();
    // Fail CLOSED: only install a cache that actually carries five_hour, so a
    // 429/5xx body never overwrites last-known-good.
    if (body?.five_hour) {
      body.fetched_at = NOW_EPOCH;
      const tmpPath = `${USAGE_CACHE}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(body, null, 2), { mode: 0o600 });
      try {
        const { renameSync } = await import("node:fs");
        renameSync(tmpPath, USAGE_CACHE);
      } catch {
        /* leave last-known-good in place */
      }
    }
  } catch {
    /* network down — last-known-good stands */
  } finally {
    releaseLock(USAGE_LOCK);
  }
}

if (REFRESH_MODE) {
  await refreshLocationWeather();
  await refreshUsage();
  process.exit(0);
}

/** Fire the refresh child only when something is actually stale. */
function maybeSpawnRefresh() {
  const locAge = exists(LOCATION_CACHE) ? NOW_EPOCH - mtime(LOCATION_CACHE) : 999999;
  const wxAge = exists(WEATHER_CACHE) ? NOW_EPOCH - mtime(WEATHER_CACHE) : 999999;
  let usageAge = 999999;
  const uc: any = readJSON(USAGE_CACHE);
  if (uc) {
    usageAge = typeof uc.fetched_at === "number" ? NOW_EPOCH - uc.fetched_at : NOW_EPOCH - mtime(USAGE_CACHE);
  }
  const needs =
    locAge > LOCATION_CACHE_TTL || wxAge > WEATHER_CACHE_TTL || usageAge > USAGE_CACHE_TTL;
  if (!needs) return;
  try {
    const child = Bun.spawn([process.execPath, import.meta.path, "--refresh"], {
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });
    child.unref();
  } catch {
    /* refresh is best-effort; the render must never depend on it */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TERMINAL WIDTH
// ─────────────────────────────────────────────────────────────────────────────

const widthCache = join(TMP, `pai-term-width-${process.env.KITTY_WINDOW_ID || "default"}`);

function detectWidth(): number {
  const cols = process.stdout.columns;
  if (cols && cols > 0) {
    try {
      writeFileSync(widthCache, String(cols));
    } catch {
      /* cache is an optimization */
    }
    return cols;
  }
  const cached = parseInt(readText(widthCache).trim(), 10);
  if (Number.isFinite(cached) && cached > 0) return cached;
  const envCols = parseInt(process.env.COLUMNS || "", 10);
  if (Number.isFinite(envCols) && envCols > 0) return envCols;
  return 80;
}

let term_width = detectWidth();
if (!term_width || term_width <= 0) term_width = 80;

const MODE = term_width < 35 ? "nano" : term_width < 55 ? "micro" : term_width < 80 ? "mini" : "normal";

let content_width = term_width;
if (content_width > 72) content_width = 72;
if (content_width < 10) content_width = 10;

const SEP_SOLID = "─".repeat(content_width);
const SEP_DASHED = "┄".repeat(content_width);
const SEP_DOT = "·".repeat(content_width);

const out: string[] = [];
const emit = (s: string) => out.push(s);
const sep = () => emit(`${SLATE_600}${SEP_SOLID}${RESET}`);

// ─────────────────────────────────────────────────────────────────────────────
// DATA GATHERING (all local reads — no forks, no network)
// ─────────────────────────────────────────────────────────────────────────────

maybeSpawnRefresh();

// Claude Code version — 24h mtime cache. The .sh forks `claude --version` on a
// miss; that fork is the one thing we cannot do cheaply, so a miss renders the
// harness version from stdin instead (present since CC 2.x) and lets the cache
// be repopulated by the .sh or a later run.
const CC_VERSION_CACHE = join(LIFEOS_DIR, "MEMORY", "STATE", "cc-version-cache.txt");
let cc_version = "";
if (exists(CC_VERSION_CACHE) && NOW_EPOCH - mtime(CC_VERSION_CACHE) < 86400) {
  cc_version = readText(CC_VERSION_CACHE).trim();
}
if (!cc_version || cc_version === "unknown") {
  cc_version = cc_version_json || "unknown";
  if (cc_version !== "unknown") {
    try {
      mkdirSync(join(LIFEOS_DIR, "MEMORY", "STATE"), { recursive: true });
      writeFileSync(CC_VERSION_CACHE, cc_version);
    } catch {
      /* cache write is best-effort */
    }
  }
}

// Model cache — other tools read this.
try {
  mkdirSync(join(LIFEOS_DIR, "MEMORY", "STATE"), { recursive: true });
  writeFileSync(MODEL_CACHE, model_name + "\n");
} catch {
  /* best-effort */
}

// ── Session label: sessions-index customTitle (/rename) > session-names.json ──
const SESSION_NAMES_FILE = join(LIFEOS_DIR, "MEMORY", "STATE", "session-names.json");
const SESSION_CACHE = join(LIFEOS_DIR, "MEMORY", "STATE", "session-name-cache.sh");
let SESSION_LABEL = "";
if (session_id) {
  const project_slug = current_dir.replace(/[/.]/g, "-");
  const SESSIONS_INDEX = join(LIFEOS_DIR, "projects", project_slug, "sessions-index.json");

  const cacheText = readText(SESSION_CACHE);
  if (cacheText) {
    const cid = cacheText.match(/cached_session_id='([^']*)'/)?.[1] || "";
    const clabel = cacheText.match(/cached_session_label='([^']*)'/)?.[1] || "";
    if (cid === session_id && clabel) {
      const cacheM = mtime(SESSION_CACHE);
      const maxSource = Math.max(mtime(SESSIONS_INDEX), mtime(SESSION_NAMES_FILE));
      if (cacheM >= maxSource) SESSION_LABEL = clabel;
    }
  }
  if (!SESSION_LABEL && exists(SESSIONS_INDEX)) {
    const idx: any = readJSON(SESSIONS_INDEX);
    const entries: any[] = Array.isArray(idx) ? idx : idx?.sessions || [];
    const hit = entries.find((e) => e?.sessionId === session_id);
    if (hit?.customTitle) SESSION_LABEL = hit.customTitle;
  }
  if (!SESSION_LABEL && exists(SESSION_NAMES_FILE)) {
    const names: any = readJSON(SESSION_NAMES_FILE);
    if (names && typeof names[session_id] === "string") SESSION_LABEL = names[session_id];
  }
  if (SESSION_LABEL) {
    try {
      writeFileSync(
        SESSION_CACHE,
        `cached_session_id='${session_id}'\ncached_session_label='${SESSION_LABEL}'\n`,
      );
    } catch {
      /* best-effort */
    }
  }
}

// ── Location / weather (cache reads only) ──
let location_city = "UNKNOWN";
let location_state = "";
let location_flag = "🌐";
if (exists(LOCATION_CACHE)) {
  const loc: any = readJSON(LOCATION_CACHE) || {};
  location_city = asciiUpper(loc.city || "");
  location_state = asciiUpper(loc.region || loc.regionName || "");
  location_flag = "";
  const cc = String(loc.countryCode || "");
  if (cc.length === 2) {
    const up = asciiUpper(cc);
    const a = up.charCodeAt(0);
    const b = up.charCodeAt(1);
    if (a >= 65 && a <= 90 && b >= 65 && b <= 90) {
      location_flag = String.fromCodePoint(0x1f1e6 + a - 65) + String.fromCodePoint(0x1f1e6 + b - 65);
    }
  }
}
const weather_str = exists(WEATHER_CACHE) ? readText(WEATHER_CACHE).replace(/\n+$/, "") : "—";

// ── Startup context estimate (only before the first API call) ──
let context_pct: number = input?.context_window?.used_percentage ?? 0;
let startup_estimate = false;
if (intPart(context_pct) === 0 && total_input === 0) {
  startup_estimate = true;
  const estCache = join(TMP, `pai-startup-estimate-${session_id || "nosess"}.sh`);
  const cachedEst = readText(estCache);
  if (cachedEst) {
    const pct = parseInt(cachedEst.match(/context_pct=(\d+)/)?.[1] || "", 10);
    if (Number.isFinite(pct)) context_pct = pct;
  } else {
    let est = 5000; // Claude Code system prompt
    est += 12000; // tool definitions
    est += idiv(fileBytes(join(CLAUDE_HOME, "CLAUDE.md")) * 10, 35);
    est += idiv(fileBytes(join(LIFEOS_DIR, "LIFEOS_SYSTEM_PROMPT.md")) * 10, 35);
    for (const f of settings?.loadAtStartup?.files || []) {
      const p = join(LIFEOS_DIR, String(f));
      if (exists(p)) est += idiv(fileBytes(p) * 10, 35);
    }
    for (const d of globFiles(join(CLAUDE_HOME, "projects"), () => true)) {
      const m = join(d, "memory", "MEMORY.md");
      if (exists(m)) est += idiv(fileBytes(m) * 10, 35);
    }
    est += (settings?.counts?.skills ?? 22) * 150;
    const agentFiles = globFiles(join(LIFEOS_DIR, "agents"), (n) => n.endsWith(".md"));
    let pluginAgents = 0;
    for (const p of globFiles(join(LIFEOS_DIR, ".plugins"), () => true)) {
      pluginAgents += globFiles(join(p, "agents"), (n) => n.endsWith(".md")).length;
    }
    est += (agentFiles.length + pluginAgents) * 200;
    est += 500; // git status block (the .sh forks `git status`; the +500 log/branch base stands)
    est += 3500; // LoadContext.hook.ts dynamic context
    est += 3000; // first user message + startup reminders
    context_pct = context_max > 0 ? idiv(est * 100, context_max) : 0;
    try {
      writeFileSync(estCache, `_est=${est}\ncontext_pct=${context_pct}\nstartup_tokens=${est}\n`);
    } catch {
      /* best-effort */
    }
  }
}

// ── Usage ──
type Usage = {
  source: "native" | "oauth";
  state: "fresh" | "absent";
  u5h: number | string;
  u5h_reset: string;
  u7d: number | string;
  u7d_reset: string;
  opus: number | null;
  sonnet: number | null;
  extra_enabled: boolean;
  extra_limit: number;
  extra_used: number;
  no_data?: boolean;
  data_age?: number;
  scoped_present?: boolean;
  scoped_name?: string;
  scoped_pct?: number;
  scoped_reset?: string;
  scoped_active?: boolean;
  active_5h?: boolean;
  active_7d?: boolean;
  spend_used_cents?: number;
  spend_limit_cents?: number;
  spend_enabled?: boolean;
};

function cacheEnrichment(u: Usage) {
  const c: any = readJSON(USAGE_CACHE);
  if (!c) return;
  const limits: any[] = Array.isArray(c.limits) ? c.limits : [];
  const scoped = limits.find((l) => l?.scope?.model != null);
  u.scoped_present = scoped != null;
  u.scoped_name = asciiUpper(scoped?.scope?.model?.display_name || "");
  u.scoped_pct = scoped?.percent ?? 0;
  u.scoped_reset = scoped?.resets_at || "";
  u.scoped_active = scoped?.is_active ?? false;
  u.active_5h = limits.find((l) => l?.kind === "session")?.is_active ?? false;
  u.active_7d = limits.find((l) => l?.kind === "weekly_all")?.is_active ?? false;
  u.spend_used_cents = c?.spend?.used?.amount_minor ?? 0;
  u.spend_limit_cents = c?.spend?.limit?.amount_minor ?? 0;
  u.spend_enabled = c?.spend?.enabled ?? false;
}

let usage: Usage | null = null;
if (MODE === "normal") {
  const cache: any = readJSON(USAGE_CACHE);
  let dataAge = 999999;
  if (cache) {
    const f = cache.fetched_at;
    dataAge = typeof f === "number" ? NOW_EPOCH - f : NOW_EPOCH - mtime(USAGE_CACHE);
  }

  if (has_native_rate_limits) {
    usage = {
      source: "native",
      state: native_usage_5h_present || native_usage_7d_present ? "fresh" : "absent",
      u5h: native_5h_val ?? 0,
      u5h_reset: rl?.five_hour?.resets_at || "",
      u7d: native_7d_val ?? 0,
      u7d_reset: rl?.seven_day?.resets_at || "",
      opus: rl?.seven_day_opus
        ? (rl.seven_day_opus.used_percentage ?? rl.seven_day_opus.utilization ?? 0)
        : null,
      sonnet: rl?.seven_day_sonnet
        ? (rl.seven_day_sonnet.used_percentage ?? rl.seven_day_sonnet.utilization ?? 0)
        : null,
      extra_enabled: rl?.extra_usage?.is_enabled ?? false,
      extra_limit: rl?.extra_usage?.monthly_limit ?? 0,
      extra_used: rl?.extra_usage?.used_credits ?? 0,
    };
    // Native payload carries no extra_usage/limits[]/spend — enrich from the
    // OAuth cache so EXT, credits and the scoped (Fable) window can render.
    if (dataAge < USAGE_HARD_EXPIRY) {
      if (!usage.extra_enabled && cache?.extra_usage?.is_enabled === true) {
        usage.extra_enabled = true;
        usage.extra_limit = cache.extra_usage.monthly_limit ?? 0;
        usage.extra_used = cache.extra_usage.used_credits ?? 0;
      }
      cacheEnrichment(usage);
    }
  } else if (cache?.five_hour && dataAge < USAGE_HARD_EXPIRY) {
    usage = {
      source: "oauth",
      state: "fresh",
      u5h: cache.five_hour.utilization ?? 0,
      u5h_reset: cache.five_hour.resets_at || "",
      u7d: cache.seven_day?.utilization ?? 0,
      u7d_reset: cache.seven_day?.resets_at || "",
      opus: cache.seven_day_opus ? (cache.seven_day_opus.utilization ?? 0) : null,
      sonnet: cache.seven_day_sonnet ? (cache.seven_day_sonnet.utilization ?? 0) : null,
      extra_enabled: cache.extra_usage?.is_enabled ?? false,
      extra_limit: cache.extra_usage?.monthly_limit ?? 0,
      extra_used: cache.extra_usage?.used_credits ?? 0,
      data_age: dataAge,
    };
    cacheEnrichment(usage);
  } else {
    usage = {
      source: "oauth",
      state: "absent",
      u5h: 0,
      u5h_reset: "",
      u7d: 0,
      u7d_reset: "",
      opus: null,
      sonnet: null,
      extra_enabled: false,
      extra_limit: 0,
      extra_used: 0,
      no_data: true,
    };
  }

  // Native rate_limits sometimes omit resets_at — backfill from the OAuth cache.
  if ((!usage.u5h_reset || !usage.u7d_reset) && cache) {
    if (!usage.u5h_reset) usage.u5h_reset = cache.five_hour?.resets_at || "";
    if (!usage.u7d_reset) usage.u7d_reset = cache.seven_day?.resets_at || "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED RENDER HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getRatingColor(val: string): string {
  if (val === "—" || !val) return SLATE_400;
  const n = intPart(val);
  if (!/^[0-9]/.test(val)) return SLATE_400;
  if (n >= 9) return RATING_10;
  if (n >= 8) return RATING_8;
  if (n >= 7) return RATING_7;
  if (n >= 6) return RATING_6;
  if (n >= 5) return RATING_5;
  if (n >= 4) return RATING_4;
  return RATING_LOW;
}

function getUsageColor(pct: number | string): string {
  const n = intPart(pct);
  if (n >= 80) return ROSE;
  if (n >= 60) return "\x1b[38;2;251;146;60m";
  if (n >= 40) return "\x1b[38;2;251;191;36m";
  return EMERALD;
}

/** Three-band bar with threshold markers at 1/3 and 2/3. */
function renderContextBar(width: number, pct: number, useSpacing = false): string {
  let output = "";
  let filled = idiv(pct * width, 100);
  if (filled < 0) filled = 0;
  const pos20 = idiv(width, 3);
  const pos60 = idiv(2 * width, 3);
  for (let i = 1; i <= width; i++) {
    if (i === pos20) {
      output += `\x1b[38;2;251;146;60m⛁${RESET}`;
    } else if (i === pos60) {
      output += `\x1b[38;2;180;40;40m⛁${RESET}`;
    } else if (i <= filled) {
      const color =
        i < pos20
          ? "\x1b[38;2;74;222;128m"
          : i < pos60
            ? "\x1b[38;2;251;146;60m"
            : "\x1b[38;2;180;40;40m";
      output += `${color}⛁${RESET}`;
    } else {
      output += `${CTX_BUCKET_EMPTY}⛁${RESET}`;
    }
    if (useSpacing) output += " ";
  }
  return output.replace(/ $/, "");
}

const raw_pct = intPart(context_pct);

// ─────────────────────────────────────────────────────────────────────────────
// COMPACT MODES (nano/micro/mini) — Windows never detects a TTY width, so these
// only fire when COLUMNS or the width cache says the pane is narrow.
// ─────────────────────────────────────────────────────────────────────────────

if (MODE !== "normal") {
  const pctColor = getUsageColor(raw_pct);
  const current_time_c = (() => {
    const p = tzParts(NOW_EPOCH, USER_TZ);
    return `${p.hhmm.slice(0, 2)}:${p.hhmm.slice(2)}`;
  })();

  // Compact modes are the only ones that show git. Read .git directly: branch
  // from HEAD, stash count from the stash reflog. No forks.
  let is_git_repo = false;
  let branch = "";
  let stash_count = 0;
  const gitDir = join(current_dir, ".git");
  if (exists(gitDir)) {
    is_git_repo = true;
    const head = readText(join(gitDir, "HEAD")).trim();
    branch = head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "detached";
    const stashLog = readText(join(gitDir, "logs", "refs", "stash"));
    stash_count = stashLog ? stashLog.split("\n").filter((l) => l.trim()).length : 0;
  }

  const learnCache = readText(join(LIFEOS_DIR, "MEMORY", "STATE", "learning-cache.sh"));
  let learnScore = "—";
  let learnTrend = "→";
  if (learnCache) {
    const today = learnCache.match(/today_avg=['"]?([^'"\n]*)/)?.[1] || "";
    const week = learnCache.match(/week_avg=['"]?([^'"\n]*)/)?.[1] || "";
    if (today && today !== "—") learnScore = today;
    else if (week && week !== "—") learnScore = week;
    const trend = learnCache.match(/trend=['"]?([^'"\n]*)/)?.[1] || "";
    learnTrend = trend === "up" ? "↗" : trend === "down" ? "↘" : "→";
  }
  const learnColor = getRatingColor(learnScore);

  const counts = settings?.counts || {};
  const work_count = counts.work ?? 0;
  const ratings_count = counts.ratings ?? 0;
  const sessions_count = 0;

  if (MODE === "nano") {
    emit(`${LIFEOS_A}${LIFEOS_LOGO}${RESET}  ${LIFEOS_P}LI${LIFEOS_A}FE${LIFEOS_I}OS${RESET} ${CTX_PRIMARY}◉${RESET}${pctColor}${raw_pct}%${RESET}`);
    let l2 = "";
    if (is_git_repo) l2 += `${GIT_PRIMARY}◈${RESET}${GIT_VALUE}${branch}${RESET} `;
    l2 += `${LEARN_LABEL}✿${RESET}${learnColor}${learnScore}${learnTrend}${RESET}`;
    emit(l2);
  } else if (MODE === "micro") {
    emit(`${LIFEOS_A}${LIFEOS_LOGO}${RESET}  ${LIFEOS_P}LI${LIFEOS_A}FE${LIFEOS_I}OS${RESET} ${CTX_PRIMARY}◉${RESET}${pctColor}${raw_pct}%${RESET}`);
    emit(
      `${GIT_PRIMARY}◈${RESET}${GIT_VALUE}${branch || "—"}${RESET}` +
        ` ${SLATE_600}│${RESET} ${LEARN_LABEL}✿${RESET}${learnColor}${learnScore}${learnTrend}${RESET}`,
    );
    emit(
      `${LEARN_PRIMARY}◎${RESET} ${LEARN_WORK}📁${RESET}${SLATE_300}${work_count}${RESET}` +
        ` ${LEARN_SIGNALS}✦${RESET}${SLATE_300}${ratings_count}${RESET}` +
        ` ${LEARN_SESSIONS}⊕${RESET}${SLATE_300}${sessions_count}${RESET}`,
    );
  } else {
    emit(
      `${SLATE_600}──${RESET} ${LIFEOS_A}${LIFEOS_LOGO}${RESET}  ${LIFEOS_P}LI${LIFEOS_A}FE${LIFEOS_I}OS${RESET}` +
        ` ${SLATE_600}──${RESET} ${LIFEOS_CITY}${location_city}${RESET} ${SLATE_600}│${RESET}` +
        ` ${LIFEOS_TIME}${current_time_c}${RESET} ${SLATE_600}│${RESET} ${LIFEOS_WEATHER}${weather_str}${RESET}`,
    );
    emit(`${CTX_PRIMARY}◉${RESET} ${renderContextBar(20, raw_pct, true)} ${pctColor}${raw_pct}%${RESET}`);
    let gl = `${GIT_PRIMARY}◈${RESET} ${GIT_VALUE}${branch || "—"}${RESET}`;
    if (stash_count > 0) gl += ` ${GIT_STASH}⊡${stash_count}${RESET}`;
    emit(gl);
    emit(
      `${LEARN_PRIMARY}◎${RESET} ${LEARN_WORK}📁${RESET}${SLATE_300}${work_count}${RESET}` +
        ` ${LEARN_SIGNALS}✦${RESET}${SLATE_300}${ratings_count}${RESET} ${SLATE_600}│${RESET}` +
        ` ${LEARN_LABEL}✿${RESET}${learnColor}${learnScore}${learnTrend}${RESET}`,
    );
  }
  process.stdout.write(out.join("\n") + "\n");
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// NORMAL MODE
// ═══════════════════════════════════════════════════════════════════════════════

// ── Header: LIFEOS │ 🇪🇸 CITY, STATE  HH:MM  ☁️ temp [│ SESSION] ──
const current_time = (() => {
  const p = tzParts(NOW_EPOCH, USER_TZ);
  return `${p.hhmm.slice(0, 2)}:${p.hhmm.slice(2)}`;
})();
const session_display = SESSION_LABEL ? asciiUpper(SESSION_LABEL) : "";

let hdrLoc = "";
let hdrLocPlain = "";
if (location_city) {
  if (location_flag) hdrLoc = `${location_flag} `;
  hdrLoc += `${LIFEOS_CITY}${location_city}${RESET}`;
  if (location_state) hdrLoc += `${SLATE_600}, ${RESET}${LIFEOS_STATE_C}${location_state}${RESET}`;
}
if (location_flag) hdrLocPlain = `${location_flag} `;
hdrLocPlain += location_city;
if (location_state) hdrLocPlain += `, ${location_state}`;
if (!hdrLocPlain) hdrLocPlain = "—";

const brand = `${LIFEOS_P}LI${LIFEOS_A}FE${LIFEOS_I}OS${RESET}`;
if (session_display) {
  emit(
    `${brand} ${SLATE_600}│${RESET} ${hdrLoc}  ${LIFEOS_TIME}${current_time}${RESET}` +
      `  ${LIFEOS_WEATHER}${weather_str}${RESET} ${SLATE_600}│${RESET} ${LIFEOS_SESSION}${session_display}${RESET}`,
  );
} else {
  const hdrLeft = `LIFEOS │ ${hdrLocPlain}  ${current_time}  ${weather_str} `;
  let fill = content_width - hdrLeft.length;
  if (fill < 2) fill = 2;
  emit(
    `${brand} ${SLATE_600}│${RESET} ${hdrLoc}  ${LIFEOS_TIME}${current_time}${RESET}` +
      `  ${LIFEOS_WEATHER}${weather_str}${RESET} ${SLATE_600}${"─".repeat(fill)}${RESET}`,
  );
}
emit(`${SLATE_600}${SEP_DASHED}${RESET}`);

// ── STATE meter ──
function dimColor(d: string): string {
  switch (d) {
    case "health":
      return "\x1b[38;2;56;189;248m";
    case "creative":
      return "\x1b[38;2;165;180;252m";
    case "freedom":
      return "\x1b[38;2;147;197;253m";
    case "relationships":
      return "\x1b[38;2;96;165;250m";
    case "finances":
      return "\x1b[38;2;37;99;235m";
    default:
      return SLATE_400;
  }
}
function tierColor(pct: string): string {
  if (!/^[0-9]+$/.test(pct)) return "\x1b[38;2;100;116;139m";
  const n = parseInt(pct, 10);
  if (n >= 75) return "\x1b[38;2;219;234;254m";
  if (n >= 50) return "\x1b[38;2;96;165;250m";
  return "\x1b[38;2;100;116;139m";
}

const stateJson: any = readJSON(join(LIFEOS_DIR, "USER", "TELOS", "LIFEOS_STATE.json"));
const dims = ["health", "creative", "freedom", "relationships", "finances"];
const dimLabels = ["HEALTH", "CREATIVITY", "FREEDOM", "RELS", "FIN"];
const pcts = ["N/A", "N/A", "N/A", "N/A", "N/A"];
if (stateJson?.dimensions) {
  const D = stateJson.dimensions;
  const put = (i: number, v: any) => {
    if (v !== null && v !== undefined && v !== "") pcts[i] = String(intPart(v));
  };
  put(0, D.health?.pct);
  put(1, D.creative?.pct);
  put(2, D.freedom?.pct);
  put(3, D.relationships?.pct);
  // finances first, money for back-compat with older TELOS files
  if (D.finances?.pct !== null && D.finances?.pct !== undefined) put(4, D.finances.pct);
  else if (D.money?.pct !== null && D.money?.pct !== undefined) put(4, D.money.pct);
}
let stateLine = `${SLATE_500}STATE:${RESET} `;
dims.forEach((d, i) => {
  const suffix = /^[0-9]+$/.test(pcts[i]) ? "%" : "";
  stateLine += `${dimColor(d)}${dimLabels[i]}${RESET} ${tierColor(pcts[i])}${pcts[i]}${suffix}${RESET}`;
  if (i < dims.length - 1) stateLine += ` ${SLATE_600}│${RESET} `;
});
emit(stateLine);

// ── EFFORT scale ──
let paiLevel = "HIGH";
switch (effort_level.toLowerCase()) {
  case "low":
    paiLevel = "LOW";
    break;
  case "medium":
    paiLevel = "MEDIUM";
    break;
  case "high":
    paiLevel = "HIGH";
    break;
  case "xhigh":
    paiLevel = "XHIGH";
    break;
  case "max":
    paiLevel = "MAX";
    break;
}
// Ultracode reports as xhigh; only the output style names it.
if (/ultracode/i.test(output_style)) paiLevel = "ULTRA";

function levelColor(l: string): string {
  switch (l) {
    case "LOW":
      return "\x1b[38;2;74;222;128m";
    case "MEDIUM":
      return "\x1b[38;2;250;204;21m";
    case "HIGH":
      return "\x1b[38;2;251;146;60m";
    case "XHIGH":
      return "\x1b[38;2;249;115;22m";
    case "MAX":
      return "\x1b[38;2;239;68;68m";
    case "ULTRA":
      return "\x1b[38;2;168;85;247m";
    default:
      return SLATE_600;
  }
}
emit(`${SLATE_600}${SEP_DOT}${RESET}`);
let pmLine = `⚡ ${RESET}`;
for (const l of ["LOW", "MEDIUM", "HIGH", "XHIGH", "MAX", "ULTRA"]) {
  pmLine += " ";
  pmLine += paiLevel === l ? `${levelColor(l)}${l}${RESET}` : `${SLATE_600}${l}${RESET}`;
}
emit(pmLine);

// ── DOCTOR (delta-only; healthy = silent) ──
const doctorSidecar = join(LIFEOS_DIR, "MEMORY", "STATE", "capabilities-statusline.txt");
if (fileBytes(doctorSidecar) > 0) {
  // Sidecar content goes through as literal text, never as escape codes — a
  // tampered file must not be able to inject sequences into the status line.
  emit(`${readText(doctorSidecar).replace(/\n+$/, "")}${RESET}`);
}

// ── MEMORY ──
function recencyStr(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "—";
  const m = idiv(s, 60);
  const h = idiv(m, 60);
  const d = idiv(h, 24);
  if (d >= 1) return `${d}d`;
  if (h >= 1) return `${h}h`;
  return `${m}m`;
}

/** Body bytes after the frontmatter, skipping blanks and HTML comments. */
function memoryBodyBytes(p: string): number {
  const t = readText(p);
  if (!t) return 0;
  let c = 0;
  let total = 0;
  for (const line of t.split("\n")) {
    if (line === "---") {
      c++;
      continue;
    }
    if (c === 2 && line.trim().length > 0 && !line.startsWith("<!--") && !line.startsWith("-->")) {
      total += Buffer.byteLength(line, "utf8") + 1;
    }
  }
  return total;
}

const reviewStateFile = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY", "review-state.json");
if (exists(reviewStateFile)) {
  const rs: any = readJSON(reviewStateFile) || {};
  const memTurns = rs.turn_count_since_last_review ?? 0;
  const memPending = rs.pending_review ?? false;
  const lastReview = rs.last_review_at || "";
  const cfg: any = readJSON(join(LIFEOS_DIR, "USER", "CONFIG", "memory-review.json")) || {};
  const memThreshold = cfg.turn_threshold ?? 8;

  let memAge = "never";
  let memAgeSec = 999999999;
  if (lastReview) {
    const then = parseIsoEpoch(lastReview);
    if (then > 0) {
      memAgeSec = Math.max(0, NOW_EPOCH - then);
      memAge = recencyStr(memAgeSec);
    }
  }

  let memHealth = "ok";
  let memHealthDetail = "";
  const healthRow = lastLine(join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY", "memory-health.jsonl"));
  if (healthRow) {
    try {
      const h = JSON.parse(healthRow);
      memHealth = h.overall || "ok";
      memHealthDetail = h.findings?.[0]?.message || "";
    } catch {
      /* a malformed row means "no signal", not "unhealthy" */
    }
  }

  let memDispatched = 0;
  const runRow = lastLine(join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY", "reviewer-runs.jsonl"));
  if (runRow) {
    try {
      const r = JSON.parse(runRow);
      if (r.ok === true) memDispatched = r.dispatch_summary?.succeeded ?? 0;
    } catch {
      /* ignore */
    }
  }

  let memPct = 0;
  const principalMem = join(LIFEOS_DIR, "USER", "PRINCIPAL", "PRINCIPAL_MEMORY.md");
  const daMem = join(LIFEOS_DIR, "USER", "DIGITAL_ASSISTANT", "DA_MEMORY.md");
  if (exists(principalMem) && exists(daMem)) {
    memPct = idiv((memoryBodyBytes(principalMem) + memoryBodyBytes(daMem)) * 100, 24576);
  }

  let memColor = MEM_SAGE;
  let memLine: string;
  if (memHealth === "critical") {
    memColor = "\x1b[38;2;239;68;68m";
    memLine = `PROBLEM · ${memHealthDetail || "RUN MEMORYHEALTHCHECK"}`;
  } else if (memHealth === "warn") {
    memColor = "\x1b[38;2;251;191;36m";
    memLine = `NEEDS ATTENTION · ${memHealthDetail || "RUN MEMORYHEALTHCHECK"}`;
  } else if (memAge !== "never" && memAgeSec <= 30 && memDispatched > 0) {
    memLine = `SAVED ${memDispatched} NEW MEMORIES JUST NOW · ${memPct}% FULL`;
  } else if (memPending === true) {
    memLine = `REVIEW QUEUED, RUNS AT NEXT PAUSE · LAST REVIEW ${memAge} AGO`;
  } else if (memTurns >= memThreshold) {
    memLine = `REVIEW DUE, WAITING FOR A QUIET MOMENT · LAST ${memAge} AGO`;
  } else if (memAge === "never") {
    memLine = `NO REVIEWS YET · FIRST ONE AFTER ${memThreshold} TURNS`;
  } else {
    memLine = `OK · REVIEWED ${memAge} AGO · NEXT IN ${memThreshold - memTurns} TURNS · ${memPct}% FULL`;
  }
  memLine = asciiUpper(memLine);
  if (memLine.length > 68) memLine = memLine.slice(0, 67) + "…";
  emit(`🧠  ${memColor}${memLine}${RESET}`);
}

sep();

// ── HARN / DEF MODEL / LIFEOS / ALGO ──
const harness_name = harness_name_json || "CC";
let harDisplay = harness_name;
if (harness_version_json && harness_version_json !== "unknown") harDisplay += ` ${harness_version_json}`;
else if (cc_version && cc_version !== "unknown") harDisplay += ` ${cc_version}`;
const modelDisplay = asciiUpper(model_name.replace(/ context/g, ""));
emit(
  `${SLATE_400}HARN:${RESET} ${LIFEOS_A}${harDisplay}${RESET} ${SLATE_600}│${RESET}` +
    ` ${SLATE_400}DEF MODEL:${RESET} ${LIFEOS_A}${modelDisplay}${RESET} ${SLATE_600}│${RESET}` +
    ` ${SLATE_400}LIFEOS:${RESET} ${LIFEOS_A}${LIFEOS_VERSION}${RESET} ${SLATE_600}│${RESET}` +
    ` ${SLATE_400}ALGO:${RESET} ${LIFEOS_A}${ALGO_VERSION}${RESET}`,
);

// ── ACTIVE roster ──
// Rung labels come from models.ts (the same source AgentInvocation.hook.ts reads),
// so a lineup flip re-labels this row automatically.
const modelsTs = readText(join(LIFEOS_DIR, "TOOLS", "models.ts"));
function emLookup(key: string, fallback: string): string {
  const block = modelsTs.match(/export const EFFORT_MODEL[^{]*\{([\s\S]*?)\n\}/)?.[1] || "";
  const m = block.match(new RegExp(`^\\s*${key}:\\s*"([a-z0-9-]*)"`, "m"));
  return m ? asciiUpper(m[1]) : fallback;
}
function cvLookup(key: string, fallback: string): string {
  const block = modelsTs.match(/export const CROSS_VENDOR[^{]*\{([\s\S]*?)\n\}/)?.[1] || "";
  const m = block.match(new RegExp(`^\\s*${key}:\\s*"([^"]*)"`, "m"));
  return m ? asciiUpper(m[1].replace(/-sol$/, "")) : fallback;
}
const lblMax = emLookup("max", "FABLE");
const lblHigh = emLookup("high", "OPUS");
const lblMed = emLookup("medium", "SONNET");
const lblLow = emLookup("low", "HAIKU");
const lblForge = cvLookup("forge", "GPT-5.6");
const lblGrok = cvLookup("grokResearcher", "GROK");
const dispatchFable = /export const DISPATCH_EXECUTES_FABLE = (\w+)/.exec(modelsTs)?.[1] || "false";

const agentStartsFile = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY", "agent-starts.json");
const agentStarts: any = readJSON(agentStartsFile) || {};
const cutoffMs = (NOW_EPOCH - 300) * 1000;
const liveEntries = Object.values(agentStarts).filter((v: any) => (v?.epoch ?? 0) > cutoffMs);
const liveModels = [...new Set(liveEntries.map((v: any) => v?.model || "inherited"))];

let fableRecent = 0;
const mvFile = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY", "model-verification.jsonl");
if (exists(mvFile)) {
  const cut = new Date((NOW_EPOCH - 300) * 1000).toISOString().slice(0, 19);
  const rows = readText(mvFile).split("\n").filter(Boolean).slice(-20);
  for (const row of rows) {
    try {
      const r = JSON.parse(row);
      if ((r.ts || "") > cut && /fable/.test(r.executed || "")) {
        fableRecent = 1;
        break;
      }
    } catch {
      /* ignore */
    }
  }
}

/** Pure: session model + live dispatches → which rungs are lit. */
function rosterStates(sessionModel: string, live: string[], fable: number, df: string) {
  let sMax = 0,
    sHigh = 0,
    sMed = 0,
    sLow = 0,
    sForge = 0,
    sGrok = 0;
  if (fable === 1) sMax = 2;
  // The session model is always active — that is what ACTIVE answers.
  if (/haiku/i.test(sessionModel)) sLow = 2;
  else if (/sonnet/i.test(sessionModel)) sMed = 2;
  else if (/fable/i.test(sessionModel)) sMax = 2;
  else if (/opus/i.test(sessionModel)) sHigh = 2;
  for (const m of live) {
    if (/grok/.test(m)) sGrok = 2;
    else if (/gpt-/.test(m)) sForge = 2;
    else if (/haiku/.test(m)) sLow = 2;
    else if (/sonnet/.test(m)) sMed = 2;
    else if (/fable/.test(m)) {
      if (df === "true") sMax = 2;
      else sHigh = 2;
    } else if (/opus/.test(m)) sHigh = 2;
    else if (m === "inherited") {
      if (/haiku/i.test(sessionModel)) sLow = 2;
      else if (/sonnet/i.test(sessionModel)) sMed = 2;
      else if (/fable/i.test(sessionModel)) {
        if (df === "true") sMax = 2;
        else sHigh = 2;
      } else sHigh = 2;
    } else sHigh = 2;
  }
  return { sMax, sHigh, sMed, sLow, sForge, sGrok };
}

const rs = rosterStates(model_name, liveModels as string[], fableRecent, dispatchFable);
function rungColor(rung: string, state: number): string {
  const live = state === 2;
  switch (rung) {
    case "low":
      return live ? "\x1b[1;38;2;74;222;128m" : "\x1b[2;38;2;86;164;110m";
    case "medium":
      return live ? "\x1b[1;38;2;59;130;246m" : "\x1b[2;38;2;90;130;185m";
    case "high":
      return live ? "\x1b[1;38;2;239;68;68m" : "\x1b[2;38;2;180;95;95m";
    case "max":
      return live ? "\x1b[1;38;2;168;85;247m" : "\x1b[2;38;2;150;110;195m";
    case "forge":
      return live ? "\x1b[1;38;2;103;232;249m" : "\x1b[2;38;2;85;160;175m";
    case "grok":
      return live ? "\x1b[1;38;2;226;232;240m" : "\x1b[2;38;2;125;135;148m";
    default:
      return RESET;
  }
}
const tok = (state: number, rung: string, label: string) => `${rungColor(rung, state)}${label}${RESET}`;
emit(
  `${SLATE_400}ACTIVE:${RESET} ` +
    `${tok(rs.sLow, "low", lblLow)} ` +
    `${tok(rs.sMed, "medium", lblMed)} ` +
    `${tok(rs.sHigh, "high", lblHigh)} ` +
    `${tok(rs.sMax, "max", lblMax)}` +
    ` ${SLATE_600}│${RESET} ` +
    `${tok(rs.sForge, "forge", "+" + lblForge)} ` +
    `${tok(rs.sGrok, "grok", "+" + lblGrok)}`,
);

// ── LIVE dispatch count ──
if (liveEntries.length > 0) {
  const noun = liveEntries.length > 1 ? "agents" : "agent";
  emit(`${SLATE_400}▸ LIVE:${RESET} ${WIELD_ACCENT}${liveEntries.length} ${noun}${RESET}`);
}
sep();

// ── CONTEXT bar ──
const display_pct = raw_pct;
const pctColor = getUsageColor(display_pct);
const ctxSuffixLen = 1 + String(display_pct).length + 1;
let barWidth = content_width - 11 - ctxSuffixLen;
if (barWidth < 16) barWidth = 16;
emit(`${CTX_SECONDARY}CONTEXT:${RESET} ${renderContextBar(barWidth, display_pct)} ${pctColor}${display_pct}%${RESET}`);
emit(`${SLATE_600}${SEP_DOT}${RESET}`);

// ── FILES: always-on context stack, sized and sorted ──
function sizePctColor(x10: number): string {
  if (x10 > 60) return RATING_LOW;
  if (x10 >= 40) return RATING_5;
  return CTX_PCT_GREEN;
}

const ctxData: { bytes: number; name: string }[] = [];
const collect = (p: string, name: string) => {
  if (exists(p)) ctxData.push({ bytes: fileBytes(p), name });
};
collect(join(LIFEOS_DIR, "LIFEOS_SYSTEM_PROMPT.md"), "LIFEOS_SYSTEM_PROMPT.md");
collect(join(CLAUDE_HOME, "CLAUDE.md"), "CLAUDE.md");
for (const line of readText(join(CLAUDE_HOME, "CLAUDE.md")).split("\n")) {
  if (line.startsWith("@")) {
    const rel = line.slice(1).trim();
    if (rel) collect(join(CLAUDE_HOME, rel), rel.split("/").pop() || rel);
  }
}
ctxData.sort((a, b) => b.bytes - a.bytes);

// Per-file cap pressure (context-budgets.json) — the inline re-bloat indicator.
const capMap = new Map<string, number>();
const capJson: any = readJSON(join(LIFEOS_DIR, "TOOLS", "context-budgets.json"));
for (const b of capJson?.budgets || []) {
  const base = String(b.path).split("/").pop();
  if (base) capMap.set(base, b.maxBytes);
}

const ctxFiles: string[] = [];
const ctxFilesColor: string[] = [];
let ctxTotalBytes = 0;
for (const e of ctxData) {
  ctxTotalBytes += e.bytes;
  const tokens = idiv(e.bytes, 4);
  const x10 = context_max > 0 ? idiv(tokens * 1000, context_max) : 0;
  const pctStr = `${idiv(x10, 10)}.${x10 % 10}%`;
  const clr = sizePctColor(x10);
  let capPlain = "";
  let capColor = "";
  const cap = capMap.get(e.name) || 0;
  if (cap > 0) {
    const capPct = idiv(e.bytes * 100, cap);
    // >=90% full is red: the number + FULL is the signal; `/trim <file>` is the action.
    if (capPct >= 90) {
      capPlain = ` ${capPct}% FULL`;
      capColor = ` \x1b[38;2;180;40;40m${capPct}% FULL${RESET}`;
    }
  }
  ctxFiles.push(`${e.name}(${pctStr})${capPlain}`);
  ctxFilesColor.push(`${CTX_SECONDARY}${e.name}(${RESET}${clr}${pctStr}${RESET}${CTX_SECONDARY})${RESET}${capColor}`);
}

// Skills description budget — session-cached single pass over SKILL.md frontmatter.
const skillsSizeCache = join(TMP, `pai-skills-size-${session_id || "nosess"}.sh`);
let skillsTotalBytes = 0;
const cachedSkills = readText(skillsSizeCache);
if (cachedSkills) {
  skillsTotalBytes = parseInt(cachedSkills.match(/_skills_total_bytes=(\d+)/)?.[1] || "0", 10) || 0;
} else {
  const skillFiles: string[] = [];
  for (const d of globFiles(join(CLAUDE_HOME, "skills"), () => true)) {
    const s = join(d, "SKILL.md");
    if (exists(s)) skillFiles.push(s);
  }
  for (const p of globFiles(join(CLAUDE_HOME, ".plugins"), () => true)) {
    for (const d of globFiles(join(p, "skills"), () => true)) {
      const s = join(d, "SKILL.md");
      if (exists(s)) skillFiles.push(s);
    }
  }
  for (const f of skillFiles) {
    const t = readText(f);
    if (!t) continue;
    for (const line of t.split("\n")) {
      if (line.startsWith("description:")) {
        const desc = line.replace(/^description:[ \t]*"?/, "").replace(/"[ \t]*$/, "");
        const sname = f.split(/[\\/]/).slice(-2)[0];
        skillsTotalBytes += 4 + sname.length + desc.length;
        break; // first description line per file
      }
    }
  }
  try {
    writeFileSync(skillsSizeCache, `_skills_total_bytes=${skillsTotalBytes}\n`);
  } catch {
    /* best-effort */
  }
}

const skillsTokens = idiv(skillsTotalBytes, 4);
const skillsX10 = context_max > 0 ? idiv(skillsTokens * 1000, context_max) : 0;
const skillsPctStr = `${idiv(skillsX10, 10)}.${skillsX10 % 10}%`;
ctxFiles.unshift(`SKILLS(${skillsPctStr})`);
ctxFilesColor.unshift(
  `${CTX_SECONDARY}SKILLS(${RESET}${sizePctColor(skillsX10)}${skillsPctStr}${RESET}${CTX_SECONDARY})${RESET}`,
);
ctxTotalBytes += skillsTotalBytes;

const ctxTotalTokens = idiv(ctxTotalBytes, 4);
const ctxTotalX10 = context_max > 0 ? idiv(ctxTotalTokens * 1000, context_max) : 0;
const ctxTotalStr = `${idiv(ctxTotalX10, 10)}.${ctxTotalX10 % 10}%`;
const ctxTotalClr = sizePctColor(ctxTotalX10);
const ctxTokStr =
  ctxTotalTokens >= 1000
    ? `${idiv(ctxTotalTokens, 1000)}.${idiv(ctxTotalTokens % 1000, 100)}K TOK`
    : `${ctxTotalTokens} TOK`;

if (ctxFiles.length > 0) {
  const prefixLen = 2;
  const indent = " ".repeat(prefixLen);
  let lineLen = prefixLen;
  let firstFile = true;
  let output = "";
  ctxFiles.forEach((ct, idx) => {
    let needed = firstFile ? ct.length : ct.length + 2;
    if (lineLen + needed > content_width && !firstFile) {
      output += "\n" + indent;
      lineLen = prefixLen;
      firstFile = true;
      needed = ct.length;
    }
    if (firstFile) {
      output += ctxFilesColor[idx];
      firstFile = false;
    } else {
      output += `${SLATE_600},${RESET} ${ctxFilesColor[idx]}`;
    }
    lineLen += needed;
  });
  const totalPlain = ` | STARTUP LOAD: ${ctxTotalStr} ≈ ${ctxTokStr}`;
  const totalColor =
    ` ${SLATE_600}|${RESET} ${CTX_SECONDARY}STARTUP LOAD:${RESET} ${ctxTotalClr}${ctxTotalStr}${RESET}` +
    ` ${SLATE_600}≈${RESET} ${ctxTotalClr}${ctxTokStr}${RESET}`;
  if (lineLen + totalPlain.length > content_width) output += "\n" + indent;
  output += totalColor;
  emit("  " + output);
}
sep();

// ── ACCOUNT USAGE ──
if (usage && usage.state !== "absent") {
  const u5 = intPart(usage.u5h);
  const u7 = intPart(usage.u7d);
  const c5 = getUsageColor(u5);
  const c7 = getUsageColor(u7);

  let reset5day = "—";
  let reset5time = "";
  let reset7day = "—";
  let reset7time = "";
  let r7str = "";
  if (usage.u5h_reset) {
    const e = parseIsoEpoch(usage.u5h_reset);
    if (e > 0) {
      const s = resetTimeStr(e);
      reset5day = s.split("@")[0];
      reset5time = s.includes("@") ? s.split("@")[1] : "";
    }
  }
  if (usage.u7d_reset) {
    const e = parseIsoEpoch(usage.u7d_reset);
    if (e > 0) {
      r7str = resetTimeStr(e);
      reset7day = r7str.split("@")[0];
      reset7time = r7str.includes("@") ? r7str.split("@")[1] : "";
    }
  }

  // Extra usage (overage credits) — values are cents.
  let extraDisplay = "";
  let creditsOffDisplay = "";
  if (usage.extra_enabled) {
    const limitDollars = idiv(usage.extra_limit || 0, 100);
    const usedDollars = idiv(intPart(usage.extra_used), 100);
    const limitFmt = limitDollars >= 1000 ? `$${idiv(limitDollars, 1000)}K` : `$${limitDollars}`;
    extraDisplay = `$${usedDollars}/${limitFmt}`;
  } else if (usage.spend_enabled === false) {
    const spUsed = idiv(intPart(usage.spend_used_cents ?? 0), 100);
    const spLimit = idiv(intPart(usage.spend_limit_cents ?? 0), 100);
    if (spLimit > 0) creditsOffDisplay = `CR:$${spUsed}/$${spLimit}·OFF`;
  }

  // Staleness dims labels only, never data values — and only on the OAuth path
  // (native arrives fresh on stdin every tick).
  let isStale = false;
  let staleSuffix = "";
  if (usage.source !== "native") {
    const age = usage.data_age ?? 0;
    if (age > 600) {
      isStale = true;
      const staleMin = idiv(age, 60);
      staleSuffix =
        staleMin >= 60
          ? ` ${USAGE_STALE}(${idiv(staleMin, 60)}h)${RESET}`
          : ` ${USAGE_STALE}(${staleMin}m)${RESET}`;
    }
  }
  const labelColor = isStale ? USAGE_STALE : USAGE_LABEL;
  const resetColor = isStale ? USAGE_STALE : USAGE_RESET_C;
  const fmtReset = (day: string, time: string) => {
    if (day === "TODAY" && time) return `${labelColor}${time}${RESET}`;
    if (time) return `${labelColor}${day}${RESET}${SLATE_600}@${RESET}${labelColor}${time}${RESET}`;
    return `${labelColor}${day}${RESET}`;
  };
  const reset5fmt = fmtReset(reset5day, reset5time);
  const reset7fmt = fmtReset(reset7day, reset7time);

  let label5 = resetColor;
  let label7 = resetColor;
  if (!isStale) {
    if (usage.active_5h) label5 = USAGE_PRIMARY;
    if (usage.active_7d) label7 = USAGE_PRIMARY;
  }

  // Scoped per-model weekly window (e.g. FABLE → FB).
  let scopedFmt = "";
  if (usage.scoped_present && usage.scoped_name) {
    const scopedInt = intPart(usage.scoped_pct);
    let scopedName = usage.scoped_name === "FABLE" ? "FB" : usage.scoped_name;
    const scopedColor = getUsageColor(scopedInt);
    let rscFmt = "";
    if (usage.scoped_reset) {
      const e = parseIsoEpoch(usage.scoped_reset);
      if (e > 0) {
        const s = resetTimeStr(e);
        // Same boundary as WEEK → redundant, drop it.
        if (s !== r7str) {
          rscFmt = ` ${resetColor}↻${RESET}${fmtReset(s.split("@")[0], s.includes("@") ? s.split("@")[1] : "")}`;
        }
      }
    }
    const scopedLabelColor = !isStale && usage.scoped_active ? USAGE_PRIMARY : resetColor;
    scopedFmt = ` ${scopedLabelColor}${scopedName}${RESET} ${scopedColor}${scopedInt}%${RESET}${rscFmt}`;
  }

  // Anthropic flips to extra credits the moment any window hits 100%.
  let extraActive = false;
  if (usage.extra_enabled) {
    for (const w of [u5, u7, usage.opus, usage.sonnet]) {
      if (w === null || w === undefined) continue;
      if (intPart(w) >= 100) {
        extraActive = true;
        break;
      }
    }
  }
  let billingFmt: string;
  if (usage.no_data) {
    billingFmt = `${USAGE_PRIMARY}API${RESET}`;
  } else if (extraActive && extraDisplay) {
    billingFmt = `${USAGE_EXTRA_ACTIVE}⚡${extraDisplay}${RESET}`;
  } else if (extraActive) {
    billingFmt = `${USAGE_EXTRA_ACTIVE}⚡EXT${RESET}`;
  } else {
    billingFmt = `${USAGE_PRIMARY}SUB${RESET}`;
    if (extraDisplay) billingFmt += ` ${USAGE_EXTRA}${extraDisplay}${RESET}`;
    if (creditsOffDisplay) billingFmt += ` ${USAGE_EXTRA}${creditsOffDisplay}${RESET}`;
  }

  emit(
    `📊 ${label5}5HR${RESET} ${c5}${u5}%${RESET} ${resetColor}↻${RESET}${reset5fmt}` +
      ` ${label7}WK${RESET} ${c7}${u7}%${RESET} ${resetColor}↻${RESET}${reset7fmt}${scopedFmt} ${billingFmt}` +
      staleSuffix,
  );
  sep();
}

// ── QUOTE: curated corpus, deterministic 60s window, no network ──
if (exists(QUOTES_FILE)) {
  const lines = readText(QUOTES_FILE).split("\n");
  const quoteCount = lines.filter((l) => l.length > 0).length;
  if (quoteCount > 0) {
    const idx = (idiv(NOW_EPOCH, 60) % quoteCount) + 1;
    const quoteLine = lines[idx - 1] || "";
    if (quoteLine.includes("|")) {
      const quoteText = quoteLine.slice(0, quoteLine.indexOf("|"));
      const quoteAuthor = quoteLine.slice(quoteLine.indexOf("|") + 1);
      if (quoteText && quoteAuthor) {
        const fullLen = quoteText.length + quoteAuthor.length + 6;
        if (fullLen <= content_width) {
          emit(`${SLATE_400}"${quoteText}"${RESET} ${QUOTE_AUTHOR}—${quoteAuthor}${RESET}`);
        } else {
          let foldW = content_width - 2;
          if (foldW < 20) foldW = 20;
          // fold -s: break at word boundaries, never mid-word
          const words = quoteText.split(" ");
          const wrapped: string[] = [];
          let cur = "";
          for (const w of words) {
            if (cur && (cur + " " + w).length > foldW) {
              wrapped.push(cur);
              cur = w;
            } else {
              cur = cur ? cur + " " + w : w;
            }
          }
          if (cur) wrapped.push(cur);
          for (let i = 0; i < wrapped.length - 1; i++) {
            emit(i === 0 ? `${SLATE_400}"${wrapped[i]}${RESET}` : `  ${SLATE_400}${wrapped[i]}${RESET}`);
          }
          const last = wrapped[wrapped.length - 1];
          const single = wrapped.length === 1;
          const lastPrefix = single ? `${SLATE_400}"` : `  ${SLATE_400}`;
          const sharedLen = (single ? 0 : 2) + (single ? 1 : 0) + last.length + 1 + 1 + 3 + quoteAuthor.length;
          if (sharedLen <= content_width) {
            emit(`${lastPrefix}${last}"${RESET} ${QUOTE_AUTHOR}—${quoteAuthor}${RESET}`);
          } else {
            emit(`${lastPrefix}${last}"${RESET}`);
            emit(`  ${QUOTE_AUTHOR}—${quoteAuthor}${RESET}`);
          }
        }
      }
    }
  }
}

process.stdout.write(out.join("\n") + "\n");

