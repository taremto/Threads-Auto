import { spawn, execFileSync } from "child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export type ClaudeCliError = Error & {
  stderr?: string;
  stdout?: string;
  code?: string | number;
  killed?: boolean;
  signal?: string;
};

export type ClaudeStatus = {
  ok: boolean;
  billingBlocked: boolean;
  platform: NodeJS.Platform;
  command: string | null;
  version: string | null;
  title: string;
  message: string;
  nextAction: string;
  riskEnvNames: string[];
  detail?: string;
};

export type ClaudeUsageWindow = {
  usedPercentage: number | null;
  resetsAt: string | null;
  resetText: string | null;
};

export type ClaudeUsageStatus = {
  available: boolean;
  status: "safe" | "caution" | "danger" | "blocked" | "unknown";
  title: string;
  message: string;
  nextAction: string;
  checkedAt: string;
  source: "live" | "cache" | "claude-cache" | "unavailable" | "no-cache" | "error";
  fiveHour: ClaudeUsageWindow;
  sevenDay: ClaudeUsageWindow;
  contextWindow?: ClaudeUsageWindow;
  plan?: ClaudeUsageWindow;
  maxRecommendedPosts: number | null;
  raw?: string;
  detail?: string;
};

export type ClaudeAuthStatus = {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  subscriptionType?: string | null;
  raw?: string;
};

export type ClaudeRunOptions = {
  timeoutMs?: number;
};

const RISKY_BILLING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_BEARER_TOKEN_BEDROCK",
];

const ANTHROPIC_DEFAULT_BASE_URL = /^https?:\/\/api\.anthropic\.com\/?$/i;
const MIN_CLAUDE_GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CLAUDE_GENERATION_TIMEOUT_MS = 15 * 60 * 1000;

let _claudeBinCache: string | null = null;
const CLAUDE_CANDIDATES =
  process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];

function desktopAppAction(): string {
  return "Claudeデスクトップアプリを開いて、このフォルダを選び、「Claudeにログインし直して」と送ってください。";
}

function installAction(): string {
  return "Claudeデスクトップアプリを開いて、このフォルダを選び、「Claude Code CLIを使えるようにセットアップして」と送ってください。終わったら、このWebUIを起動し直してください。";
}

function loginAction(): string {
  return "Claudeデスクトップアプリを開いて、このフォルダを選び、「Claude Code CLIにログインし直して」と送ってください。終わったら、この画面の「再確認」を押してください。";
}

export function billingRiskEnvNames(
  env: Record<string, string | undefined> = process.env
): string[] {
  return RISKY_BILLING_ENV.filter((key) => {
    const raw = env[key];
    if (!raw) return false;
    const v = raw.trim();
    if (!v) return false;
    const normalized = v.toLowerCase();
    if (normalized === "0" || normalized === "false" || normalized === "no") {
      return false;
    }
    if (key === "ANTHROPIC_BASE_URL" && ANTHROPIC_DEFAULT_BASE_URL.test(v)) {
      return false;
    }
    return true;
  });
}

function extraBinDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.bun/bin`,
    `${home}/.volta/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (appData) dirs.push(path.join(appData, "npm"));
    if (localAppData) {
      dirs.push(path.join(localAppData, "Programs", "npm"));
      dirs.push(path.join(localAppData, "Volta", "bin"));
    }
    if (programFiles) dirs.push(path.join(programFiles, "nodejs"));
    if (programFilesX86) dirs.push(path.join(programFilesX86, "nodejs"));
  }
  return dirs;
}

function pathWithExtraBins(): string {
  const parts = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of extraBinDirs()) if (!parts.includes(d)) parts.push(d);
  return parts.join(path.delimiter);
}

function sanitizedClaudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: pathWithExtraBins() };
  for (const key of RISKY_BILLING_ENV) delete env[key];
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
  return env;
}

function textFromExecError(e: unknown): string {
  const err = e as {
    message?: string;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    output?: Array<Buffer | string | null>;
  };
  const chunks = [
    err.stdout,
    err.output?.[1],
    err.stderr,
    err.output?.[2],
    err.message,
  ];
  return chunks
    .map((chunk) =>
      Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : typeof chunk === "string"
          ? chunk
          : ""
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isClaudeLoginRequiredText(text: string): boolean {
  return /not\s+logged\s+in|please\s+run\s+\/login|login\s+required|not\s+authenticated|unauthorized/i.test(
    text
  );
}

function isClaudeExecutable(p: string): boolean {
  try {
    return (
      fs.existsSync(/*turbopackIgnore: true*/ p) &&
      fs.statSync(/*turbopackIgnore: true*/ p).isFile()
    );
  } catch {
    return false;
  }
}

export function resolveClaudeBin(): string {
  if (_claudeBinCache) return _claudeBinCache;
  for (const sh of ["/bin/zsh", "/bin/bash"]) {
    if (!fs.existsSync(/*turbopackIgnore: true*/ sh)) continue;
    for (const flags of [["-lic"], ["-lc"]]) {
      try {
        const out = execFileSync(
          sh,
          [...flags, "command -v claude 2>/dev/null"],
          {
            encoding: "utf8",
            timeout: 6000,
            stdio: ["ignore", "pipe", "ignore"],
            env: sanitizedClaudeEnv(),
          }
        );
        const hit = out
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .reverse()
          .find((l) => isClaudeExecutable(l));
        if (hit) {
          _claudeBinCache = hit;
          return hit;
        }
      } catch {
        /* このシェル/フラグでは失敗 */
      }
    }
  }
  for (const d of extraBinDirs()) {
    for (const bin of CLAUDE_CANDIDATES) {
      const p = path.join(d, bin);
      if (isClaudeExecutable(p)) {
        _claudeBinCache = p;
        return p;
      }
    }
  }
  _claudeBinCache = process.platform === "win32" ? "claude.cmd" : "claude";
  return _claudeBinCache;
}

function claudeSpawnCommand(): { command: string; argsPrefix: string[]; bin: string } {
  const bin = resolveClaudeBin();
  if (process.platform === "win32" && bin.toLowerCase().endsWith(".cmd")) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      argsPrefix: ["/d", "/s", "/c", bin],
      bin,
    };
  }
  return { command: bin, argsPrefix: [], bin };
}

export function parseClaudeAuthStatus(raw: string): ClaudeAuthStatus | null {
  try {
    const text = raw.trim();
    const jsonText = text.startsWith("{")
      ? text
      : text.match(/\{[\s\S]*\}/)?.[0] ?? text;
    const parsed = JSON.parse(jsonText) as {
      loggedIn?: unknown;
      authMethod?: unknown;
      apiProvider?: unknown;
      subscriptionType?: unknown;
    };
    if (typeof parsed.loggedIn !== "boolean") return null;
    return {
      loggedIn: parsed.loggedIn,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      apiProvider: typeof parsed.apiProvider === "string" ? parsed.apiProvider : null,
      subscriptionType:
        typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
      raw,
    };
  } catch {
    return null;
  }
}

function readClaudeAuthStatus(claude = claudeSpawnCommand()): ClaudeAuthStatus | null {
  try {
    const raw = execFileSync(
      claude.command,
      [...claude.argsPrefix, "auth", "status"],
      {
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedClaudeEnv(),
      }
    ).trim();
    return parseClaudeAuthStatus(raw);
  } catch (e) {
    const text = textFromExecError(e);
    const parsed = parseClaudeAuthStatus(text);
    if (parsed) return parsed;
    if (isClaudeLoginRequiredText(text)) {
      return {
        loggedIn: false,
        authMethod: null,
        apiProvider: null,
        subscriptionType: null,
        raw: text.slice(0, 1000),
      };
    }
    return null;
  }
}

function detectClaudeLoginRequired(claude = claudeSpawnCommand()): string | null {
  try {
    execFileSync(
      claude.command,
      [
        ...claude.argsPrefix,
        "-p",
        "--no-session-persistence",
        "--max-turns",
        "1",
        "--output-format",
        "text",
        "/context",
      ],
      {
        encoding: "utf8",
        timeout: 6000,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedClaudeEnv(),
      }
    );
    return null;
  } catch (e) {
    const text = textFromExecError(e);
    return isClaudeLoginRequiredText(text) ? text.slice(0, 1000) : null;
  }
}

export function checkClaudeStatus(): ClaudeStatus {
  const riskEnvNames = billingRiskEnvNames();
  if (riskEnvNames.length > 0) {
    return {
      ok: false,
      billingBlocked: true,
      platform: process.platform,
      command: null,
      version: null,
      title: "安全のためAI生成を止めています",
      message:
        "従量課金につながる可能性がある設定が見つかりました。高額請求を防ぐため、この状態では生成しません。",
      nextAction:
        "Claudeデスクトップアプリを開いて、このフォルダを選び、「従量課金にならないようにClaudeのログイン設定を直して」と送ってください。",
      riskEnvNames,
    };
  }

  try {
    const claude = claudeSpawnCommand();
    const version = execFileSync(
      claude.command,
      [...claude.argsPrefix, "--version"],
      {
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedClaudeEnv(),
      }
    ).trim();
    const auth = readClaudeAuthStatus(claude);
    if (auth && !auth.loggedIn) {
      return {
        ok: false,
        billingBlocked: false,
        platform: process.platform,
        command: claude.bin,
        version: version || "確認済み",
        title: "Claude Code CLIのログインが必要です",
        message:
          "Claudeアプリ側でログイン済みでも、このWebUIが使うClaude Code CLI側のログインが切れています。",
        nextAction: loginAction(),
        riskEnvNames,
        detail: auth.raw?.slice(0, 300),
      };
    }
    if (!auth) {
      const loginRequired = detectClaudeLoginRequired(claude);
      if (loginRequired) {
        return {
          ok: false,
          billingBlocked: false,
          platform: process.platform,
          command: claude.bin,
          version: version || "確認済み",
          title: "Claude Code CLIのログインが必要です",
          message:
            "Claudeアプリ側でログイン済みでも、このWebUIが使うClaude Code CLI側のログインが切れています。",
          nextAction: loginAction(),
          riskEnvNames,
          detail: loginRequired.slice(0, 300),
        };
      }
    }
    return {
      ok: true,
      billingBlocked: false,
      platform: process.platform,
      command: claude.bin,
      version: version || "確認済み",
      title: "Claudeの準備はできています",
      message: "AI生成はClaudeの月額プラン側で動きます。APIキーによる従量課金設定は検出されませんでした。",
      nextAction: "このまま生成できます。",
      riskEnvNames,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      billingBlocked: false,
      platform: process.platform,
      command: null,
      version: null,
      title: "Claudeの準備が必要です",
      message:
        "Claudeアプリを使っていても、投稿生成に必要なClaude Code CLIの準備がまだ終わっていない可能性があります。",
      nextAction: installAction(),
      riskEnvNames,
      detail: raw.slice(0, 300),
    };
  }
}

const USAGE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const CLAUDE_RATE_LIMIT_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

function emptyUsageWindow(): ClaudeUsageWindow {
  return { usedPercentage: null, resetsAt: null, resetText: null };
}

function usageCachePath(): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "logs", "claude-usage.json");
}

function claudeRateLimitCachePath(): string {
  return path.join(/*turbopackIgnore: true*/ os.homedir(), ".claude", ".ratelimit_cache.json");
}

// 「再確認 / AI生成」ボタンが押されたときだけ、5h/7d 使用率を1回更新する。
// 直近3分以内に更新済みなら claude を叩かない（連打・モーダル再オープンで
// Pro セッション枠を無駄に消費しないため）。多重起動も相乗りで防ぐ。
const USAGE_REFRESH_SKIP_MS = 3 * 60 * 1000;
let _usageRefreshInFlight: Promise<void> | null = null;

export function triggerUsageRefreshOnce(): Promise<void> {
  if (_usageRefreshInFlight) return _usageRefreshInFlight;

  try {
    const st = fs.statSync(
      /*turbopackIgnore: true*/ claudeRateLimitCachePath()
    );
    if (Date.now() - st.mtimeMs < USAGE_REFRESH_SKIP_MS) {
      return Promise.resolve();
    }
  } catch {
    /* キャッシュ無し → 更新する */
  }

  // scripts/usage-refresher.cjs は webアプリフォルダ直下の scripts/ にある
  const script = path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    "scripts",
    "usage-refresher.cjs"
  );
  if (!fs.existsSync(/*turbopackIgnore: true*/ script)) {
    return Promise.resolve(); // スクリプトが無ければ従来どおり（何もしない）
  }

  _usageRefreshInFlight = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      _usageRefreshInFlight = null;
      resolve();
    };
    try {
      const child = spawn(process.execPath, [script], {
        cwd: process.cwd(),
        // node-pty を webアプリの node_modules から確実に解決させる
        env: {
          ...process.env,
          NODE_PATH: path.join(
            /*turbopackIgnore: true*/ process.cwd(),
            "node_modules"
          ),
        },
        stdio: "ignore",
        windowsHide: true,
      });
      const killer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish();
      }, 90000);
      child.on("exit", () => {
        clearTimeout(killer);
        finish();
      });
      child.on("error", () => {
        clearTimeout(killer);
        finish();
      });
    } catch {
      finish();
    }
  });
  return _usageRefreshInFlight;
}

function clampPercent(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function firstPercent(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? clampPercent(Number(m[1])) : null;
}

function resetTextFromLine(line: string): string | null {
  const trimmed = line.replace(/\s+/g, " ").trim();
  if (!/reset|リセット/i.test(trimmed)) return null;
  const ja = trimmed.match(/(?:あと|約)?\s*(\d+)\s*時間(?:\s*(\d+)\s*分)?(?:後)?に?リセット/);
  if (ja) {
    const h = Number(ja[1]);
    const m = ja[2] ? Number(ja[2]) : 0;
    if (h > 0 && m > 0) return `約${h}時間${m}分後にリセット`;
    if (h > 0) return `約${h}時間後にリセット`;
    if (m > 0) return `約${m}分後にリセット`;
  }
  const rel = trimmed.match(/(?:resets?|reset)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m)\b/i);
  if (rel) {
    const n = Math.ceil(Number(rel[1]));
    const unit = rel[2].toLowerCase();
    return unit.startsWith("h") || unit.startsWith("hr")
      ? `約${n}時間後にリセット`
      : `約${n}分後にリセット`;
  }
  const at = trimmed.match(/resets?\s+(?:at\s+)?([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)/i);
  if (at) return `${at[1]}ごろリセット`;
  return trimmed.slice(0, 80);
}

function resetTextFromIso(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const diffMs = t - Date.now();
  if (diffMs <= 0) return null;
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `約${minutes}分後にリセット`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 48) {
    return restMinutes > 0
      ? `約${hours}時間${restMinutes}分後にリセット`
      : `約${hours}時間後にリセット`;
  }
  const formatted = new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
  return `${formatted}ごろリセット`;
}

function validIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return value;
}

function usageWindowFromRateLimit(raw: unknown): ClaudeUsageWindow {
  if (!raw || typeof raw !== "object") return emptyUsageWindow();
  const data = raw as Record<string, unknown>;
  const utilization = data.utilization;
  const usedPercentage = data.used_percentage;
  let pct: number | null = null;

  if (typeof utilization === "number") {
    pct = clampPercent(utilization <= 1 ? utilization * 100 : utilization);
  } else if (typeof usedPercentage === "number") {
    pct = clampPercent(usedPercentage);
  }

  const resetsAt = validIsoDate(data.resets_at ?? data.resetsAt);
  if (resetsAt && Date.parse(resetsAt) <= Date.now()) {
    return emptyUsageWindow();
  }

  return {
    usedPercentage: pct,
    resetsAt,
    resetText: resetTextFromIso(resetsAt),
  };
}

function usageWindowFromPercent(
  usedPercentage: number | null,
  resetText: string | null = null
): ClaudeUsageWindow {
  return { usedPercentage, resetsAt: null, resetText };
}

export function parseClaudeRateLimitCache(raw: string): ClaudeUsageStatus | null {
  try {
    const parsed = JSON.parse(raw) as {
      timestamp?: unknown;
      data?: {
        five_hour?: unknown;
        seven_day?: unknown;
      };
    };
    const timestamp = typeof parsed.timestamp === "number" ? parsed.timestamp * 1000 : null;
    if (
      !timestamp ||
      !Number.isFinite(timestamp) ||
      Date.now() - timestamp > CLAUDE_RATE_LIMIT_CACHE_MAX_AGE_MS
    ) {
      return null;
    }

    const data = parsed.data;
    if (!data || typeof data !== "object") return null;
    const fiveHour = usageWindowFromRateLimit(data.five_hour);
    const sevenDay = usageWindowFromRateLimit(data.seven_day);
    const hasAny =
      fiveHour.usedPercentage !== null ||
      fiveHour.resetText !== null ||
      sevenDay.usedPercentage !== null ||
      sevenDay.resetText !== null;
    if (!hasAny) return null;
    const status = deriveUsageStatus(fiveHour, sevenDay, "claude-cache", raw);
    if (status.status !== "blocked") return status;
    return {
      ...status,
      status: "danger",
      title: "Claude使用量がかなり多いです",
      message: `現在のセッション使用量は約${fiveHour.usedPercentage ?? 100}%です。大量生成は控えめにしてください。`,
      nextAction: "生成する場合は1〜2投稿だけにしてください。",
      maxRecommendedPosts: 2,
    };
  } catch {
    return null;
  }
}

function findWindowUsage(raw: string, patterns: RegExp[]): ClaudeUsageWindow {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const nearby = lines[i];
    if (!patterns.some((p) => p.test(nearby))) continue;
    const windowLines = lines.slice(i, Math.min(lines.length, i + 4));
    const pct = firstPercent(windowLines.join(" "));
    const resetLine = lines
      .slice(i, Math.min(lines.length, i + 4))
      .find((line) => /reset|リセット/i.test(line));
    return {
      usedPercentage: pct,
      resetsAt: null,
      resetText: resetLine ? resetTextFromLine(resetLine) : null,
    };
  }

  return emptyUsageWindow();
}

function usageWindowFromObject(raw: unknown): ClaudeUsageWindow {
  if (!raw || typeof raw !== "object") return emptyUsageWindow();
  const data = raw as Record<string, unknown>;
  const used =
    typeof data.used_percentage === "number"
      ? data.used_percentage
      : typeof data.usedPercentage === "number"
        ? data.usedPercentage
        : typeof data.utilization === "number"
          ? data.utilization <= 1
            ? data.utilization * 100
            : data.utilization
          : null;
  const resetsAt = validIsoDate(data.resets_at ?? data.resetsAt);
  return {
    usedPercentage: used === null ? null : clampPercent(used),
    resetsAt,
    resetText: resetTextFromIso(resetsAt),
  };
}

function parseClaudeUsageJson(raw: string): ClaudeUsageStatus | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const contextWindow = usageWindowFromObject(
      parsed.context_window ?? parsed.contextWindow
    );
    const rateLimits =
      parsed.rate_limits && typeof parsed.rate_limits === "object"
        ? (parsed.rate_limits as Record<string, unknown>)
        : {};
    const fiveHour = usageWindowFromObject(
      rateLimits.five_hour ?? rateLimits.fiveHour ?? parsed.five_hour
    );
    const sevenDay = usageWindowFromObject(
      rateLimits.seven_day ?? rateLimits.sevenDay ?? parsed.seven_day
    );
    const plan = usageWindowFromObject(parsed.plan ?? parsed.plan_usage ?? parsed.planUsage);
    const hasAny =
      contextWindow.usedPercentage !== null ||
      fiveHour.usedPercentage !== null ||
      sevenDay.usedPercentage !== null ||
      plan.usedPercentage !== null;
    if (!hasAny) return null;
    return deriveUsageStatus(fiveHour, sevenDay, "live", raw, contextWindow, plan);
  } catch {
    return null;
  }
}

function contextWindowFromContextCommand(text: string): ClaudeUsageWindow {
  const tokenLine = text.match(/\bTokens\s*:\s*[^\n]*?\((\d+(?:\.\d+)?)\s*%\)/i);
  if (tokenLine) {
    return usageWindowFromPercent(clampPercent(Number(tokenLine[1])));
  }
  return findWindowUsage(text, [/^#+\s*Context Usage/i, /コンテキスト/i]);
}

export function parseClaudeUsageCommandOutput(raw: string): ClaudeUsageStatus {
  const text = raw || "";
  const json = parseClaudeUsageJson(text.trim());
  if (json) return json;

  const contextMatch = text.match(/\bcontext(?:\s+window)?\s*:?\s*(\d+(?:\.\d+)?)\s*%/i);
  const planMatch = text.match(/\bplan(?:\s+usage)?\s*:?\s*(\d+(?:\.\d+)?)\s*%/i);
  const compactFive = text.match(/\b(?:5h|five[_-\s]?hour)\s*:?\s*(\d+(?:\.\d+)?)\s*%/i);
  const compactSeven = text.match(/\b(?:7d|seven[_-\s]?day)\s*:?\s*(\d+(?:\.\d+)?)\s*%/i);

  const fiveHour =
    compactFive
      ? usageWindowFromPercent(clampPercent(Number(compactFive[1])))
      : findWindowUsage(text, [
          /現在のセッション/i,
          /current\s+session/i,
          /5\s*(?:h|hour|hours)/i,
          /five[-\s]?hour/i,
          /session\s+limit/i,
        ]);
  const sevenDay =
    compactSeven
      ? usageWindowFromPercent(clampPercent(Number(compactSeven[1])))
      : findWindowUsage(text, [
          /週間制限|週(?:間)?/i,
          /weekly|week/i,
          /7\s*(?:d|day|days)/i,
          /seven[-\s]?day/i,
          /weekly\s+limit/i,
        ]);
  const contextWindow = contextMatch
    ? usageWindowFromPercent(clampPercent(Number(contextMatch[1])))
    : contextWindowFromContextCommand(text);
  const plan = planMatch
    ? usageWindowFromPercent(clampPercent(Number(planMatch[1])))
    : emptyUsageWindow();

  return deriveUsageStatus(fiveHour, sevenDay, "live", text, contextWindow, plan);
}

function deriveUsageStatus(
  fiveHour: ClaudeUsageWindow,
  sevenDay: ClaudeUsageWindow,
  source: ClaudeUsageStatus["source"],
  raw?: string,
  contextWindow: ClaudeUsageWindow = emptyUsageWindow(),
  plan: ClaudeUsageWindow = emptyUsageWindow()
): ClaudeUsageStatus {
  const now = new Date().toISOString();
  const values = [fiveHour.usedPercentage, sevenDay.usedPercentage, plan.usedPercentage].filter(
    (v): v is number => typeof v === "number"
  );
  const maxUsed = values.length > 0 ? Math.max(...values) : null;
  const resetHint = fiveHour.resetText || sevenDay.resetText || plan.resetText || null;

  if (maxUsed === null) {
    if (contextWindow.usedPercentage !== null) {
      return {
        available: true,
        status: "safe",
        title: "Claude Codeはログイン済みです",
        message:
          "現在のセッション使用量はClaude Code CLIから取得できません。生成中に上限エラーが出たら停止します。",
        nextAction: "このまま生成できます。",
        checkedAt: now,
        source,
        fiveHour,
        sevenDay,
        contextWindow,
        plan,
        maxRecommendedPosts: null,
        raw,
      };
    }
    return {
      available: false,
      status: "unknown",
      title: "Claude使用量を確認できません",
      message:
        "Claude Codeが公開している上限数値をこのPCでは確認できませんでした。生成時に上限エラーが出たら停止します。",
      nextAction: "不安な場合は、まず2〜4投稿だけ生成してください。",
      checkedAt: now,
      source,
      fiveHour,
      sevenDay,
      contextWindow,
      plan,
      maxRecommendedPosts: null,
      raw,
    };
  }

  if (maxUsed >= 98) {
    return {
      available: true,
      status: "blocked",
      title: "Claudeの利用上限に近い状態です",
      message: `現在の使用量は約${maxUsed}%です。今まとめて生成すると途中で止まる可能性が高いです。`,
      nextAction: resetHint
        ? `${resetHint}。リセット後に生成してください。`
        : "時間をおいてから生成してください。",
      checkedAt: now,
      source,
      fiveHour,
      sevenDay,
      contextWindow,
      plan,
      maxRecommendedPosts: 0,
      raw,
    };
  }

  if (maxUsed >= 90) {
    return {
      available: true,
      status: "danger",
      title: "Claude使用量がかなり多いです",
      message: `現在の使用量は約${maxUsed}%です。大量生成は止めています。`,
      nextAction: "生成する場合は1〜2投稿だけにしてください。",
      checkedAt: now,
      source,
      fiveHour,
      sevenDay,
      contextWindow,
      plan,
      maxRecommendedPosts: 2,
      raw,
    };
  }

  if (maxUsed >= 80) {
    return {
      available: true,
      status: "caution",
      title: "Claude使用量が多めです",
      message: `現在の使用量は約${maxUsed}%です。まとめて生成すると途中で止まる可能性があります。`,
      nextAction: "安全のため、今回は4投稿までにしてください。",
      checkedAt: now,
      source,
      fiveHour,
      sevenDay,
      contextWindow,
      plan,
      maxRecommendedPosts: 4,
      raw,
    };
  }

  if (maxUsed >= 70) {
    return {
      available: true,
      status: "caution",
      title: "Claude使用量に少し注意が必要です",
      message: `現在の使用量は約${maxUsed}%です。まだ使えますが、大量生成は控えめが安全です。`,
      nextAction: "安全のため、今回は8投稿までがおすすめです。",
      checkedAt: now,
      source,
      fiveHour,
      sevenDay,
      contextWindow,
      plan,
      maxRecommendedPosts: 8,
      raw,
    };
  }

  return {
    available: true,
    status: "safe",
    title: "Claude使用量は安全圏です",
    message: `現在の使用量は約${maxUsed}%です。通常通り生成できます。`,
    nextAction: "このまま生成できます。",
    checkedAt: now,
    source,
    fiveHour,
    sevenDay,
    contextWindow,
    plan,
    maxRecommendedPosts: null,
    raw,
  };
}

export function parseClaudeUsageOutput(raw: string): ClaudeUsageStatus {
  const text = raw || "";
  const fiveHour = findWindowUsage(text, [
    /現在のセッション/i,
    /current\s+session/i,
    /5\s*(?:h|hour|hours)/i,
    /five[-\s]?hour/i,
  ]);
  const sevenDay = findWindowUsage(text, [
    /週間制限|週(?:間)?/i,
    /weekly|week/i,
    /7\s*(?:d|day|days)/i,
    /seven[-\s]?day/i,
  ]);

  const percentages = Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)).map(
    (m) => clampPercent(Number(m[1]))
  ).filter((n): n is number => n !== null);
  if (fiveHour.usedPercentage === null && percentages[0] != null) {
    fiveHour.usedPercentage = percentages[0];
  }
  if (sevenDay.usedPercentage === null && percentages[1] != null) {
    sevenDay.usedPercentage = percentages[1];
  }

  return deriveUsageStatus(fiveHour, sevenDay, "live", text);
}

function readUsageCache(): ClaudeUsageStatus | null {
  try {
    const file = usageCachePath();
    if (!fs.existsSync(/*turbopackIgnore: true*/ file)) return null;
    const stat = fs.statSync(/*turbopackIgnore: true*/ file);
    if (Date.now() - stat.mtimeMs > USAGE_CACHE_MAX_AGE_MS) return null;
    const parsed = JSON.parse(
      fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")
    ) as ClaudeUsageStatus;
    if (
      typeof parsed.message === "string" &&
      /コンテキスト使用量/.test(parsed.message)
    ) {
      return null;
    }
    if (parsed.status === "blocked" && parsed.source !== "error") return null;
    return parsed.source === "error" ? parsed : { ...parsed, source: "cache" };
  } catch {
    return null;
  }
}

function loginRequiredUsageStatus(detail?: string): ClaudeUsageStatus {
  return {
    available: false,
    status: "unknown",
    title: "Claude Code CLIのログインが必要です",
    message:
      "Claudeアプリ側でログイン済みでも、このWebUIが使用量確認に使うClaude Code CLI側のログインが切れています。",
    nextAction: loginAction(),
    checkedAt: new Date().toISOString(),
    source: "unavailable",
    fiveHour: emptyUsageWindow(),
    sevenDay: emptyUsageWindow(),
    contextWindow: emptyUsageWindow(),
    plan: emptyUsageWindow(),
    maxRecommendedPosts: null,
    detail: detail?.slice(0, 1000),
  };
}

function readClaudeUsageCommand(): ClaudeUsageStatus | null {
  const claude = claudeSpawnCommand();
  try {
    // 新しめの Claude Code（2.1.x〜）では、スラッシュコマンドを位置引数で
    // 渡すと普通のテキスト（ファイルパス）として扱われ /context が実行されない。
    // stdin から渡すとスラッシュコマンドとして実行されるため、こちらを使う。
    const raw = execFileSync(
      claude.command,
      [
        ...claude.argsPrefix,
        "-p",
        "--no-session-persistence",
        "--max-turns",
        "1",
        "--output-format",
        "text",
      ],
      {
        encoding: "utf8",
        timeout: 20_000,
        input: "/context\n",
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizedClaudeEnv(),
      }
    ).trim();
    const usage = parseClaudeUsageCommandOutput(raw);
    // /context はコンテキスト使用量のみ返す（5h/7d/プラン枠は別系統で出ない）。
    // コンテキスト使用量だけでも deriveUsageStatus が available な状態を返す
    // 設計なので、コンテキスト値も「取得できた」と認める。
    const hasLimitUsage =
      usage.fiveHour.usedPercentage !== null ||
      usage.sevenDay.usedPercentage !== null ||
      usage.plan?.usedPercentage !== null ||
      usage.contextWindow?.usedPercentage !== null;
    if (!hasLimitUsage) return null;
    return usage.status === "unknown" ? null : { ...usage, raw: undefined };
  } catch (e) {
    const text = textFromExecError(e);
    if (isClaudeLoginRequiredText(text)) return loginRequiredUsageStatus(text);
    return null;
  }
}

function writeUsageCache(status: ClaudeUsageStatus) {
  try {
    fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(usageCachePath()), {
      recursive: true,
    });
    fs.writeFileSync(
      /*turbopackIgnore: true*/ usageCachePath(),
      JSON.stringify(status, null, 2)
    );
  } catch {
    /* 使用量表示は補助機能なので、キャッシュ失敗では止めない */
  }
}

function readClaudeRateLimitCache(): ClaudeUsageStatus | null {
  try {
    const file = claudeRateLimitCachePath();
    if (!fs.existsSync(/*turbopackIgnore: true*/ file)) return null;
    const stat = fs.statSync(/*turbopackIgnore: true*/ file);
    if (Date.now() - stat.mtimeMs > CLAUDE_RATE_LIMIT_CACHE_MAX_AGE_MS) return null;
    const status = parseClaudeRateLimitCache(
      fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")
    );
    return status ? { ...status, raw: undefined } : null;
  } catch {
    return null;
  }
}

function unavailableUsageStatus(
  title: string,
  message: string,
  nextAction: string,
  detail?: string
): ClaudeUsageStatus {
  return {
    available: false,
    status: "unknown",
    title,
    message,
    nextAction,
    checkedAt: new Date().toISOString(),
    source: "unavailable",
    fiveHour: emptyUsageWindow(),
    sevenDay: emptyUsageWindow(),
    contextWindow: emptyUsageWindow(),
    plan: emptyUsageWindow(),
    maxRecommendedPosts: null,
    detail,
  };
}

// 新規セットアップ直後など、Claude Code 側の rate-limit キャッシュがまだ
// 生成されていない状態。生成自体は問題なくできる（available: true）。
// status: "unknown" は維持しつつ source: "no-cache" でフロント側が区別する。
function noCacheUsageStatus(): ClaudeUsageStatus {
  return {
    available: true,
    status: "unknown",
    title: "プラン使用率はまだ取得できていません",
    message:
      "1回目の生成が終わるとClaude Code側から5時間枠・週間枠の使用率が届いて、ここに表示されます。",
    nextAction: "このまま生成を進められます。",
    checkedAt: new Date().toISOString(),
    source: "no-cache",
    fiveHour: emptyUsageWindow(),
    sevenDay: emptyUsageWindow(),
    contextWindow: emptyUsageWindow(),
    plan: emptyUsageWindow(),
    maxRecommendedPosts: null,
  };
}

export function getClaudeUsageStatus(options: { refresh?: boolean } = {}): ClaudeUsageStatus {
  let cached: ClaudeUsageStatus | null = null;
  if (!options.refresh) {
    cached = readUsageCache();
    if (cached && cached.status !== "unknown") return cached;
  }

  const riskEnvNames = billingRiskEnvNames();
  if (riskEnvNames.length > 0) {
    return unavailableUsageStatus(
      "Claude使用量を確認できません",
      "従量課金につながる可能性がある設定が見つかったため、使用量確認も止めています。",
      "まずClaudeのログイン設定を直してください。",
      riskEnvNames.join(", ")
    );
  }

  const auth = readClaudeAuthStatus();
  if (auth && !auth.loggedIn) {
    return unavailableUsageStatus(
      "Claude Code CLIのログインが必要です",
      "Claudeアプリ側でログイン済みでも、このWebUIが使用量確認に使うClaude Code CLI側のログインが切れています。",
      loginAction(),
      auth.raw
    );
  }

  const liveUsage = readClaudeUsageCommand();

  // 5時間/週間のプラン使用率（statusLineブリッジ由来の .ratelimit_cache.json）が
  // 取れていれば、それを主軸にする。/context はコンテキスト使用量しか返さないため、
  // それだけ先に return するとプラン枠メーターが永遠に出ない（順序の問題）。
  // コンテキスト使用量は /context 側から補完してマージする。
  const rateLimitCache = readClaudeRateLimitCache();
  if (rateLimitCache) {
    if (
      liveUsage?.contextWindow?.usedPercentage != null &&
      rateLimitCache.contextWindow?.usedPercentage == null
    ) {
      rateLimitCache.contextWindow = liveUsage.contextWindow;
    }
    writeUsageCache(rateLimitCache);
    return rateLimitCache;
  }

  if (liveUsage) {
    // 5h/7d/プラン枠がまだ取れていない（context だけ取れている）状態 =
    // 新規セットアップ直後で statusLine ブリッジ経由のキャッシュをまだ書いていない。
    // メーター3本とも null で「現在のセッション使用量はClaude Code CLIから取得できません〜」
    // と煽るメッセージが出るのを避け、「初回生成後に表示されます」案内に置き換える。
    const hasLimitData =
      liveUsage.fiveHour?.usedPercentage != null ||
      liveUsage.sevenDay?.usedPercentage != null ||
      liveUsage.plan?.usedPercentage != null;
    if (!hasLimitData) {
      return noCacheUsageStatus();
    }
    writeUsageCache(liveUsage);
    return liveUsage;
  }

  if (!cached) cached = readUsageCache();
  if (cached) return cached;

  return noCacheUsageStatus();
}

export function estimateClaudeGenerationTimeoutMs(args: {
  promptChars: number;
  count: number;
}): number {
  const promptChars = Math.max(0, args.promptChars || 0);
  const count = Math.max(1, args.count || 1);
  // 大きいナレッジ + 10本以上の生成は5分を超える実例があるため、
  // 投稿数とプロンプト量に応じて待ち時間を伸ばす。
  const estimated =
    3 * 60 * 1000 +
    count * 45 * 1000 +
    Math.ceil(promptChars / 1000) * 1000;
  return Math.max(
    MIN_CLAUDE_GENERATION_TIMEOUT_MS,
    Math.min(MAX_CLAUDE_GENERATION_TIMEOUT_MS, estimated)
  );
}

export function runClaude(
  prompt: string,
  options: ClaudeRunOptions = {}
): Promise<string> {
  const riskEnvNames = billingRiskEnvNames();
  if (riskEnvNames.length > 0) {
    const e: ClaudeCliError = new Error(
      `billing risk env detected: ${riskEnvNames.join(", ")}`
    );
    e.code = "BILLING_RISK_ENV";
    throw e;
  }

  return new Promise<string>((resolve, reject) => {
    const startedAt = Date.now();
    const timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? options.timeoutMs
        : MIN_CLAUDE_GENERATION_TIMEOUT_MS;
    const claude = claudeSpawnCommand();
    const child = spawn(
      claude.command,
      [
        ...claude.argsPrefix,
        "-p",
        "--model",
        "opus",
        "--fallback-model",
        "sonnet",
        "--output-format",
        "text",
      ],
      { env: sanitizedClaudeEnv() }
    );

    let stdout = "";
    let stderr = "";
    let killedForTimeout = false;
    let killedForSize = false;
    const MAX_OUTPUT = 16 * 1024 * 1024;

    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT) {
        killedForSize = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const e = err as ClaudeCliError;
      e.stderr = stderr;
      e.stdout = stdout;
      reject(e);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !killedForTimeout && !killedForSize) {
        resolve(stdout.trim());
        return;
      }
      const elapsedMs = Date.now() - startedAt;
      const e: ClaudeCliError = new Error(
        killedForSize
          ? "claude output exceeded size limit"
          : killedForTimeout
            ? `claude timed out after ${timeoutMs}ms`
          : `claude exited with code=${code ?? "null"} signal=${signal ?? "null"}`
      );
      e.stderr = stderr;
      e.stdout = stdout
        ? `${stdout}\n\n[elapsedMs=${elapsedMs} timeoutMs=${timeoutMs}]`
        : `[elapsedMs=${elapsedMs} timeoutMs=${timeoutMs}]`;
      e.code = code ?? undefined;
      e.signal = signal ?? undefined;
      e.killed = killedForTimeout || signal === "SIGTERM";
      reject(e);
    });

    child.stdin.on("error", () => {
      /* EPIPE 等は close 側で扱う */
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function waitMessage(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ");
  const rel = text.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m)\b/i);
  if (!rel) return null;
  const n = Number(rel[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = rel[2].toLowerCase();
  if (unit.startsWith("h") || unit.startsWith("hr")) {
    return `あと約${Math.ceil(n)}時間待ってから、もう一度「生成開始」を押してください。`;
  }
  return `あと約${Math.ceil(n)}分待ってから、もう一度「生成開始」を押してください。`;
}

function isClaudeUsageLimitText(text: string): boolean {
  return /usage limit|rate[_ ]?limit|429|too many requests|quota exceeded|overloaded|capacity|session limit|weekly limit|limit reached/.test(
    text
  );
}

export function recordClaudeUsageLimitError(raw: string) {
  const text = raw.toLowerCase();
  if (!isClaudeUsageLimitText(text)) return;
  const wait = waitMessage(raw);
  const blocked = deriveUsageStatus(
    { ...emptyUsageWindow(), usedPercentage: 100, resetText: wait },
    emptyUsageWindow(),
    "error",
    raw.slice(0, 1000)
  );
  writeUsageCache(blocked);
}

export function describeClaudeCliError(
  raw: string,
  err: { code?: string | number; killed?: boolean; signal?: string }
): string {
  const text = raw.toLowerCase();

  if (err.code === "BILLING_RISK_ENV") {
    return (
      "安全のためAI生成を止めました。\n" +
      "このPCに、従量課金につながる可能性がある設定が入っています。高額請求を防ぐため、この状態では生成しません。\n" +
      "次にやること: Claudeデスクトップアプリを開いて、このフォルダを選び、「従量課金にならないようにClaudeのログイン設定を直して」と送ってください。"
    );
  }

  if (
    err.killed ||
    err.signal === "SIGTERM" ||
    /timed?\s*out|etimedout|timeout/.test(text)
  ) {
    return (
      "Claudeからの返事が時間内に返ってきませんでした。\n" +
      "混雑しているか、生成本数が多すぎる可能性があります。\n" +
      "次にやること: 生成本数を減らして、もう一度「生成開始」を押してください。"
    );
  }

  if (
    err.code === "ENOENT" ||
    /command not found|not recognized|no such file|spawn claude|enoent/.test(text)
  ) {
    return (
      "Claudeの準備がまだ終わっていません。\n" +
      "Claudeアプリを使っていても、投稿生成に必要なClaude Code CLIがこのPCで見つからない状態です。\n" +
      `次にやること: ${installAction()}`
    );
  }

  if (
    /credit balance is too low|insufficient_quota|insufficient credit|not enough credit|purchase (more )?credits|billing|spending limit|payment required|out of credits/.test(
      text
    )
  ) {
    return (
      "安全のためAI生成を止めました。\n" +
      "Claudeが従量課金側で動こうとしている可能性があります。このツールは月額プランの範囲で使う前提です。\n" +
      `次にやること: ${desktopAppAction()}`
    );
  }

  if (
    /invalid[_ ]?api[_ ]?key|invalid x-api-key|authentication[_ ]?error|401|unauthorized|not (logged in|authenticated)|please run.*\/login|run `?claude\/login`?|login required|oauth/.test(
      text
    )
  ) {
    return (
      "Claudeへのログインが切れています。\n" +
      "AI生成を使うには、Claudeの月額プランに入っているアカウントでログインしている必要があります。\n" +
      `次にやること: ${desktopAppAction()}`
    );
  }

  if (isClaudeUsageLimitText(text)) {
    const wait = waitMessage(raw);
    return (
      "Claudeの利用上限に達しています。\n" +
      "いまはClaude側で一時的に生成できません。これはツールの故障ではありません。\n" +
      `次にやること: ${wait || "数時間待ってから、もう一度「生成開始」を押してください。"}`
    );
  }

  const head = raw.replace(/\s+/g, " ").trim().slice(0, 300);
  return (
    "Claudeでの生成中に問題が起きました。\n" +
    `次にやること: ${desktopAppAction()}\n` +
    (head ? `サポート用メモ: ${head}` : "")
  );
}
