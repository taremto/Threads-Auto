import { spawn } from "node:child_process";

export type CodexCliError = Error & {
  code?: string | number;
  killed?: boolean;
  signal?: string;
  stderr?: string;
  stdout?: string;
};

export type CodexRunOptions = {
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const BILLING_ENV_NAMES = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_BASE_URL",
];

function sanitizedCodexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of BILLING_ENV_NAMES) {
    delete env[name];
  }
  return env;
}

export function runCodex(
  prompt: string,
  options: CodexRunOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const command = process.platform === "win32" ? "codex.exe" : "codex";
    const child = spawn(
      command,
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--disable",
        "plugins",
        "--disable",
        "apps",
        "--disable",
        "browser_use",
        "--disable",
        "computer_use",
        "--disable",
        "multi_agent",
        "--disable",
        "hooks",
        "-c",
        'forced_login_method="chatgpt"',
        "-",
      ],
      {
        cwd: process.cwd(),
        env: sanitizedCodexEnv(),
        windowsHide: true,
      }
    );

    let stdout = "";
    let stderr = "";
    let killedForTimeout = false;
    let killedForSize = false;

    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
        killedForSize = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(-MAX_OUTPUT_BYTES);
      }
    });

    child.on("error", (error: CodexCliError) => {
      clearTimeout(timer);
      error.stderr = stderr;
      error.stdout = stdout;
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !killedForTimeout && !killedForSize) {
        resolve(stdout.trim());
        return;
      }

      const error = new Error(
        killedForTimeout
          ? "Codex CLI timed out"
          : killedForSize
            ? "Codex CLI output exceeded limit"
            : `Codex CLI exited with code ${code ?? "unknown"}`
      ) as CodexCliError;
      error.code = killedForTimeout
        ? "ETIMEDOUT"
        : killedForSize
          ? "OUTPUT_LIMIT"
          : code ?? "UNKNOWN";
      error.killed = killedForTimeout || killedForSize;
      error.signal = signal ?? undefined;
      error.stderr = stderr;
      error.stdout = stdout;
      reject(error);
    });

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        console.error("Codex CLI stdin error:", error);
      }
    });
    child.stdin.end(prompt);
  });
}

export function describeCodexCliError(
  raw: string,
  error: Pick<CodexCliError, "code" | "killed" | "signal">
): string {
  const text = raw.toLowerCase();

  if (
    error.code === "ETIMEDOUT" ||
    error.killed ||
    error.signal === "SIGTERM" ||
    /timed?\s*out|timeout/.test(text)
  ) {
    return "Codexから時間内に返事がありませんでした。少し時間を置いて、もう一度お試しください。";
  }

  if (
    error.code === "ENOENT" ||
    /command not found|not recognized|no such file|spawn codex|enoent/.test(text)
  ) {
    return "Codex CLIが見つかりません。Codexデスクトップアプリを最新版にしてから、Webアプリを再起動してください。";
  }

  if (
    /not logged in|login required|authentication required|unauthorized|401/.test(
      text
    )
  ) {
    return "Codexにログインできていません。CodexデスクトップアプリでChatGPTにログインしてから、もう一度お試しください。";
  }

  if (
    /usage limit|rate.?limit|too many requests|quota|limit reached|429/.test(
      text
    )
  ) {
    return "Codexの利用上限に達している可能性があります。時間を置くか、AI選択をClaudeに切り替えてください。";
  }

  if (/forced_login_method|login method|api key/.test(text)) {
    return "CodexがChatGPTログインになっていません。従量課金を避けるため停止しました。CodexデスクトップアプリでChatGPTログインに切り替えてください。";
  }

  return "Codexでの変換に失敗しました。Codexデスクトップアプリのログイン状態を確認して、もう一度お試しください。";
}
