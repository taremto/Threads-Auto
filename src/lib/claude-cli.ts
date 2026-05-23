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

const RISKY_BILLING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_BEARER_TOKEN_BEDROCK",
];

let _claudeBinCache: string | null = null;
const CLAUDE_CANDIDATES =
  process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];

function desktopAppAction(): string {
  return "Claudeデスクトップアプリを開いて、このフォルダを選び、「Claudeにログインし直して」と送ってください。";
}

function installAction(): string {
  return "Claudeデスクトップアプリを開いて、このフォルダを選び、「Claude Code CLIを使えるようにセットアップして」と送ってください。";
}

export function billingRiskEnvNames(
  env: Record<string, string | undefined> = process.env
): string[] {
  // ANTHROPIC_BASE_URL が公式デフォルトURLのみの場合は安全（Claude Code が自動セットする値）
  const SAFE_BASE_URLS = ["https://api.anthropic.com", "https://api.anthropic.com/"];
  return RISKY_BILLING_ENV.filter((key) => {
    const v = env[key];
    if (!v?.trim()) return false;
    const normalized = v.trim().toLowerCase();
    if (normalized === "0" || normalized === "false" || normalized === "no") return false;
    if (key === "ANTHROPIC_BASE_URL" && SAFE_BASE_URLS.includes(v.trim())) return false;
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
  return env;
}

function isClaudeExecutable(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function resolveClaudeBin(): string {
  if (_claudeBinCache) return _claudeBinCache;
  for (const sh of ["/bin/zsh", "/bin/bash"]) {
    if (!fs.existsSync(sh)) continue;
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
      message: "このPCでAI生成を動かすためのClaudeが見つからない、またはログイン確認ができません。",
      nextAction: installAction(),
      riskEnvNames,
      detail: raw.slice(0, 300),
    };
  }
}

export function runClaude(prompt: string): Promise<string> {
  const riskEnvNames = billingRiskEnvNames();
  if (riskEnvNames.length > 0) {
    const e: ClaudeCliError = new Error(
      `billing risk env detected: ${riskEnvNames.join(", ")}`
    );
    e.code = "BILLING_RISK_ENV";
    throw e;
  }

  return new Promise<string>((resolve, reject) => {
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
    }, 300000);

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
      const e: ClaudeCliError = new Error(
        killedForSize
          ? "claude output exceeded size limit"
          : `claude exited with code=${code ?? "null"} signal=${signal ?? "null"}`
      );
      e.stderr = stderr;
      e.stdout = stdout;
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
      "このツールのAI生成には、Claudeデスクトップアプリで使うClaude Code CLIが必要です。\n" +
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

  if (
    /usage limit|rate[_ ]?limit|429|too many requests|quota exceeded|overloaded|capacity|session limit|limit reached/.test(
      text
    )
  ) {
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
