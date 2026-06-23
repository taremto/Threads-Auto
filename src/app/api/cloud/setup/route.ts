import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { validateObservedThreadsUserId } from "@/lib/account-identity";
import { syncOneAccount } from "@/lib/gas-sync";
import {
  cancelByPostId,
  endpointFromAccount,
  gasVersionUpgradeMessage,
  healthCheck,
  isGasVersionSupported,
  pushQueue,
  setConfig,
  toJstString,
  tokenFingerprintOf,
  verifyQueueByPostIds,
  type PushPostInput,
} from "@/lib/gas-bridge";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLASP_TIMEOUT_MS = 120_000;
const GAS_REPAIR_VERIFY_ATTEMPTS = 5;
const GAS_REPAIR_VERIFY_INTERVAL_MS = 4_000;
const GAS_REPAIR_SETCONFIG_TIMEOUT_MS = 15_000;
const GAS_REPAIR_HEALTH_TIMEOUT_MS = 10_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function claspCommand() {
  return process.platform === "win32" ? "clasp.cmd" : "clasp";
}

function webAppUrlFromDeploymentId(id: string): string {
  return `https://script.google.com/macros/s/${id}/exec`;
}

function extractWebAppUrls(text: string): string[] {
  return Array.from(
    new Set(text.match(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/g) || [])
  );
}

function extractDeploymentIds(text: string): string[] {
  return Array.from(new Set(text.match(/AKfycb[A-Za-z0-9_-]+/g) || []));
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function beginnerClaspError(error: unknown): string {
  const detail = error as { message?: string; stderr?: string; stdout?: string; code?: string };
  const raw = [detail.message, detail.stderr, detail.stdout, detail.code]
    .filter(Boolean)
    .join("\n");
  const lower = raw.toLowerCase();
  if (lower.includes("enoent") || lower.includes("not found") || lower.includes("command")) {
    return "Googleへコードを送る準備が見つかりません。先にこのフォルダの 04_cloud_setup_mac.command（Windowsは 04_cloud_setup_windows.bat）を1回開いて、Googleログインまで完了してください。";
  }
  if (lower.includes("not logged in") || lower.includes("login") || lower.includes("unauthorized")) {
    return "Googleへのログインが切れています。このフォルダの 04_cloud_setup_mac.command（Windowsは 04_cloud_setup_windows.bat）を開き、Googleログインをやり直してください。";
  }
  return "Google投稿の修復に失敗しました。時間をおいてもう一度押してください。直らない場合はサポート用レポートを送ってください。";
}

async function runClasp(args: string[], cwd: string) {
  try {
    const isWin = process.platform === "win32";
    // Node (>=18.20.2 / 20.12.2 / 21.7.3, incl. v22+/v24) refuses to spawn
    // .cmd/.bat files without shell:true and throws "spawn EINVAL". On Windows
    // clasp is "clasp.cmd", so we must run it through a shell. With shell:true
    // args are not auto-quoted, so quote any that contain spaces/specials
    // (e.g. the version/deploy description which includes Japanese + a timestamp).
    const finalArgs = isWin
      ? args.map((a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
      : args;
    return await execFileAsync(claspCommand(), finalArgs, {
      cwd,
      timeout: CLASP_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      shell: isWin,
    });
  } catch (e) {
    throw new Error(beginnerClaspError(e));
  }
}

async function ensureClaspReady(cwd: string) {
  await runClasp(["--version"], cwd);
  await runClasp(["login", "--status"], cwd);
}

async function safeDeploymentUrls(cwd: string): Promise<string[]> {
  try {
    const out = await runClasp(["deployments"], cwd);
    const raw = `${out.stdout || ""}\n${out.stderr || ""}`;
    return [
      ...extractWebAppUrls(raw),
      ...extractDeploymentIds(raw).map(webAppUrlFromDeploymentId),
    ];
  } catch {
    return [];
  }
}

function extractVersionNumber(text: string): string | null {
  const direct = text.match(/(?:created\s+version|version)\s+(\d+)/i);
  if (direct) return direct[1];
  const first = text.match(/\b\d+\b/);
  return first?.[0] || null;
}

function gasReadyError(data: {
  version?: string | null;
  configured?: boolean;
  hasTrigger?: boolean;
  scriptTimeZone?: string | null;
}): string | null {
  if (!isGasVersionSupported(data.version)) {
    return gasVersionUpgradeMessage(data.version);
  }
  if (!data.configured) {
    return "Google側の初期設定が未完了です。Google投稿の修復を実行してください。";
  }
  if (data.scriptTimeZone && data.scriptTimeZone !== "Asia/Tokyo") {
    return "Google側のタイムゾーンが Asia/Tokyo ではありません。Google投稿の修復を実行してください。";
  }
  if (!data.hasTrigger) {
    return "Google側の自動実行が見つかりません。Google投稿の修復を実行してください。";
  }
  return null;
}

function gasFingerprintError(
  observedFingerprint: string | null | undefined,
  expectedFingerprint: string | null,
  observedUserId: string | null | undefined
): string | null {
  // GAS がトークンを自動リフレッシュすると、同じ Threads アカウントでも
  // Web 側に保存済みの fingerprint と世代差が出る。userId が取れている場合は
  // validateObservedThreadsUserId をアカウント同一性の主判定にする。
  if (observedUserId) return null;
  if (!expectedFingerprint || !observedFingerprint) {
    return "Google側のアクセストークン指紋を確認できません。誤投稿を防ぐため、Google投稿の修復を実行してください。";
  }
  if (observedFingerprint !== expectedFingerprint) {
    return "Google側のアクセストークンが、このアカウントのものと一致しません。誤投稿を防ぐため、Google投稿の修復を実行してください。";
  }
  return null;
}

function gasTokenMetaUpdate(data: {
  tokenFingerprint?: string | null;
  tokenExpiresAt?: string | null;
}): { tokenFingerprint?: string; tokenExpiresAt?: Date | null } {
  const update: { tokenFingerprint?: string; tokenExpiresAt?: Date | null } = {};
  if (data.tokenFingerprint) {
    update.tokenFingerprint = data.tokenFingerprint;
  }
  if (data.tokenExpiresAt !== undefined) {
    if (data.tokenExpiresAt) {
      const d = new Date(data.tokenExpiresAt);
      if (Number.isFinite(d.getTime())) update.tokenExpiresAt = d;
    } else {
      update.tokenExpiresAt = null;
    }
  }
  return update;
}

async function writeCloudRepairLog(entry: Record<string, unknown>) {
  try {
    const logsDir = path.join(process.cwd(), "logs");
    await mkdir(logsDir, { recursive: true });
    await appendFile(
      path.join(logsDir, "cloud-repair.log"),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
      "utf8"
    );
  } catch (e) {
    console.warn("[cloud-repair] log write failed:", e);
  }
}

async function verifyGasQueueOrThrow(endpoint: { url: string; key: string }, webPostIds: string[]) {
  const vr = await verifyQueueByPostIds(endpoint, webPostIds);
  if (!vr.ok || !vr.data) {
    throw new Error("Google側に予約が入ったか確認できませんでした: " + (vr.error || "不明"));
  }
  if (vr.data.missing.length > 0) {
    throw new Error(
      "Google側に入っていない予約があります。Web画面では予約済みにしませんでした。もう一度お試しください。（不足: " +
        vr.data.missing.length +
        "件）"
    );
  }
  const notWaiting = vr.data.rows.filter((r) => r.status !== "待機中");
  if (notWaiting.length > 0) {
    throw new Error(
      "Google側の予約状態が待機中ではありません。重複投稿を避けるため停止しました。今すぐ同期して状態を確認してください。"
    );
  }
}

async function pushQueueAndVerifyOrThrow(endpoint: { url: string; key: string }, posts: PushPostInput[]) {
  if (posts.length === 0) return { rows: 0 };
  const pr = await pushQueue(endpoint, posts);
  if (!pr.ok) {
    throw new Error("GASへのPush失敗: " + (pr.error || "不明"));
  }
  await verifyGasQueueOrThrow(
    endpoint,
    posts.map((p) => p.webPostId)
  );
  return { rows: pr.data?.rows ?? posts.length };
}

/** 切替の最中はWeb cron も processQueue も止める（migrationLock） */
async function withMigrationLock<T>(
  fn: () => Promise<T>
): Promise<{ result: T; held: boolean }> {
  // 既存ロックがあるか確認
  const existing = await prisma.appSetting.findUnique({
    where: { key: "migrationLock" },
  });
  if (existing?.value === "true") {
    throw new Error("migrationLock 取得失敗（別の切替処理が進行中）");
  }
  await prisma.appSetting.upsert({
    where: { key: "migrationLock" },
    create: { key: "migrationLock", value: "true" },
    update: { value: "true" },
  });
  try {
    const result = await fn();
    return { result, held: true };
  } finally {
    await prisma.appSetting.upsert({
      where: { key: "migrationLock" },
      create: { key: "migrationLock", value: "false" },
      update: { value: "false" },
    });
  }
}

/**
 * /api/cloud/setup
 *
 * クラウドオフロード設定の各ステップを処理する単一エンドポイント。
 * body.action で分岐:
 *   - "healthCheck": 入力されたURL/Keyに疎通確認（Account保存はしない、検証のみ）
 *   - "initialize":  setConfig をGASに送り、Account に URL/Key/SpreadsheetId を保存
 *                    成功時は cloudOffloadEnabled は触らず、ユーザーが明示ONにする手順
 *   - "enable":      cloudOffloadEnabled=true。未来の既存queuedだけを現在のGASへ転送して executor="gas" にする
 *   - "disable":     cloudOffloadEnabled=false。transferBack時はGAS側queuedをWeb側へ戻す
 *   - "repairCloudPosting": GASを最新版にし、動くWeb App URLを保存し直し、予約キューを検証
 *   - "upgradeGasCode": 旧UI互換。repairCloudPosting と同じ処理
 *   - "generateKey": 32-byteのランダムkeyを返却（クライアント側で控えてもらう）
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = body.action as string;

    if (action === "generateKey") {
      // setup-cloud.sh と同じ要領で安全な乱数キー生成
      const key = randomBytes(32).toString("base64url");
      return NextResponse.json({ ok: true, key });
    }

    const accountId = body.accountId as string;
    if (!accountId) {
      return NextResponse.json(
        { error: "accountId required" },
        { status: 400 }
      );
    }
    const account = await prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account) {
      return NextResponse.json(
        { error: "account not found" },
        { status: 404 }
      );
    }

    // healthCheck: 入力されたURL/Keyに疎通確認
    if (action === "healthCheck") {
      const url = body.gasWebAppUrl as string;
      const key = body.gasWebAppKey as string;
      if (!url || !key) {
        return NextResponse.json(
          { error: "gasWebAppUrl と gasWebAppKey が必要です" },
          { status: 400 }
        );
      }
      const duplicate = await prisma.account.findFirst({
        where: { gasWebAppUrl: url, id: { not: accountId } },
        select: { name: true },
      });
      if (duplicate) {
        return NextResponse.json(
          {
            ok: false,
            error:
              `このGoogle連携は「${duplicate.name}」で使われています。` +
              "誤投稿を防ぐため、アカウントごとに別々のGoogle連携が必要です。自動セットアップをやり直してください。",
          },
          { status: 409 }
        );
      }
      const r = await healthCheck({ url, key });
      if (!r.ok) {
        return NextResponse.json(
          { ok: false, error: r.error || "GAS疎通失敗", httpStatus: r.httpStatus },
          { status: 502 }
        );
      }
      return NextResponse.json({ ok: true, ...r.data });
    }

    // repairCloudPosting / upgradeGasCode:
    // 既存のGASプロジェクトに最新版コードを送り、新しいWeb Appデプロイを作り、
    // 実際に healthCheck が通るURLだけをDBへ保存する。
    // 旧URLが404でも、ここで作った新URLに差し替えるので「更新したのに反映不明」を残さない。
    if (action === "repairCloudPosting" || action === "upgradeGasCode") {
      const webappKey = account.gasWebAppKey;
      if (!webappKey) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "このアカウントはまだGoogle投稿の認証キーがありません。先にクラウドオフロードをセットアップしてください。",
          },
          { status: 400 }
        );
      }
      if (!account.accessToken) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "このアカウントのThreadsアクセストークンが保存されていません。先にアカウント編集でアクセストークンを保存してください。",
          },
          { status: 400 }
        );
      }

      const gasWorkDir = path.join(process.cwd(), "gas-deploy", accountId);
      const claspPath = path.join(gasWorkDir, ".clasp.json");
      let claspJson: Record<string, unknown>;
      try {
        claspJson = JSON.parse(await readFile(claspPath, "utf8")) as Record<string, unknown>;
      } catch {
        return NextResponse.json(
          {
            ok: false,
            error:
              "このアカウントのGAS更新に必要な作業情報が見つかりません。古いフォルダから更新した場合は、もう一度アップデートを実行してください。分からない場合はサポート用レポートを送ってください。",
          },
          { status: 404 }
        );
      }
      const scriptId = String(claspJson.scriptId || "");
      if (!scriptId) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "GAS更新に必要なIDを読み取れませんでした。サポート用レポートを送ってください。",
          },
          { status: 400 }
        );
      }

      let repairLockHeld = false;
      const repairLockKey = `cloudRepair:${accountId}`;
      try {
        const existingLock = await prisma.appSetting.findUnique({
          where: { key: repairLockKey },
        });
        if (existingLock?.value === "true") {
          return NextResponse.json(
            {
              ok: false,
              error:
                "このアカウントのGoogle投稿を修復中です。少し待ってからもう一度「Google投稿を修復する」を押してください。",
            },
            { status: 409 }
          );
        }
        await prisma.appSetting.upsert({
          where: { key: repairLockKey },
          create: { key: repairLockKey, value: "true" },
          update: { value: "true" },
        });
        repairLockHeld = true;

        await mkdir(gasWorkDir, { recursive: true });
        await writeFile(
          claspPath,
          JSON.stringify({ ...claspJson, scriptId, rootDir: gasWorkDir }, null, 2) + "\n",
          "utf8"
        );
        await ensureClaspReady(gasWorkDir);

        await copyFile(
          path.join(process.cwd(), "gas", "appscript.gs"),
          path.join(gasWorkDir, "appscript.gs")
        );
        await copyFile(
          path.join(process.cwd(), "gas", "appsscript.json"),
          path.join(gasWorkDir, "appsscript.json")
        );

        await runClasp(["push", "--force"], gasWorkDir);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const versionOut = await runClasp(["version", `Google投稿修復 ${stamp}`], gasWorkDir);
        const versionRaw = `${versionOut.stdout || ""}\n${versionOut.stderr || ""}`;
        const versionNumber = extractVersionNumber(versionRaw);
        const deployArgs = [
          "deploy",
          "--description",
          `Google投稿修復 ${stamp}`,
        ];
        if (versionNumber) {
          deployArgs.push("--versionNumber", versionNumber);
        }
        const deployOut = await runClasp(deployArgs, gasWorkDir);

        const deployRaw = `${deployOut.stdout || ""}\n${deployOut.stderr || ""}`;
        const deployedUrls = uniqueStrings([
          ...extractWebAppUrls(deployRaw),
          ...extractDeploymentIds(deployRaw).map(webAppUrlFromDeploymentId),
        ]);
        const fallbackUrls =
          deployedUrls.length > 0 ? [] : await safeDeploymentUrls(gasWorkDir);
        const candidateUrls = uniqueStrings(
          deployedUrls.length > 0
            ? deployedUrls
            : [...fallbackUrls, ...(account.gasWebAppUrl ? [account.gasWebAppUrl] : [])]
        ).slice(0, 3);
        if (candidateUrls.length === 0) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "Google側にコードは送れましたが、Web App URLを取得できませんでした。Googleログインを確認して、もう一度「Google投稿を修復する」を押してください。",
            },
            { status: 502 }
          );
        }

        // デプロイ直後はGoogle側の反映に時間がかかることがある。
        // ただし未確認のままOKにはしない。実際にsetConfigとhealthCheckが通ったURLだけ保存する。
        let lastHealthError = "";
        let lastDiagnostics: Record<string, unknown> | null = null;
        const expectedFingerprint = tokenFingerprintOf(account.accessToken);
        if (!expectedFingerprint) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "このアカウントのThreadsアクセストークンを安全に確認できません。アクセストークンを保存し直してから、Google投稿を修復してください。",
            },
            { status: 400 }
          );
        }
        const queuedGasBefore = await prisma.post.count({
          where: { accountId, status: "queued", executor: "gas" },
        });
        const shouldUseCloudQueue = account.cloudOffloadEnabled || queuedGasBefore > 0;
        for (let i = 0; i < GAS_REPAIR_VERIFY_ATTEMPTS; i++) {
          if (i > 0) await sleep(GAS_REPAIR_VERIFY_INTERVAL_MS);
          for (const candidateUrl of candidateUrls) {
            const attempt = i + 1;
            const duplicate = await prisma.account.findFirst({
              where: { gasWebAppUrl: candidateUrl, id: { not: accountId } },
              select: { name: true },
            });
            if (duplicate) {
              lastHealthError =
                `Google側のURLが「${duplicate.name}」でも使われています。誤投稿を防ぐため、このURLは使いません。`;
              lastDiagnostics = {
                candidateUrl,
                attempt,
                error: lastHealthError,
              };
              await writeCloudRepairLog({
                event: "candidate_rejected_duplicate_url",
                accountId,
                accountName: account.name,
                ...lastDiagnostics,
              });
              continue;
            }
            const sc = await setConfig(
              { url: candidateUrl, key: webappKey },
              {
                token: account.accessToken,
                webappKey,
                webappUrl: candidateUrl,
              },
              { retries: 0, timeoutMs: GAS_REPAIR_SETCONFIG_TIMEOUT_MS }
            );
            if (!sc.ok) {
              lastHealthError = sc.error || "Google側の初期化に失敗しました";
              lastDiagnostics = {
                candidateUrl,
                attempt,
                error: lastHealthError,
              };
              await writeCloudRepairLog({
                event: "set_config_failed",
                accountId,
                accountName: account.name,
                ...lastDiagnostics,
              });
              continue;
            }
            const hc = await healthCheck(
              { url: candidateUrl, key: webappKey },
              { retries: 0, timeoutMs: GAS_REPAIR_HEALTH_TIMEOUT_MS }
            );
            if (!hc.ok || !hc.data) {
              lastHealthError = hc.error || "確認できませんでした";
              lastDiagnostics = {
                candidateUrl,
                attempt,
                error: lastHealthError,
              };
              await writeCloudRepairLog({
                event: "health_check_failed",
                accountId,
                accountName: account.name,
                ...lastDiagnostics,
              });
              continue;
            }
            const observedUserId = hc.data.userId || sc.data?.user_id || null;
            const expectedUserId = account.threadsUserId || null;
            const observed = {
              version: hc.data.version,
              userId: observedUserId,
              tokenFingerprint: hc.data.tokenFingerprint || null,
            };
            const expected = {
              userId: expectedUserId,
              tokenFingerprint: expectedFingerprint,
            };
            const readyError = gasReadyError(hc.data);
            if (readyError) {
              lastHealthError = readyError;
              lastDiagnostics = {
                candidateUrl,
                attempt,
                error: readyError,
                expected,
                observed,
              };
              await writeCloudRepairLog({
                event: "gas_not_ready",
                accountId,
                accountName: account.name,
                ...lastDiagnostics,
              });
              continue;
            }
            let verifiedThreadsUserId: string | null = null;
            let backfilledThreadsUserId = false;
            if (observedUserId) {
              const identityCheck = await validateObservedThreadsUserId(
                {
                  accountId,
                  accountName: account.name,
                  currentThreadsUserId: account.threadsUserId,
                },
                observedUserId
              );
              if (!identityCheck.ok) {
                lastHealthError = identityCheck.error;
                lastDiagnostics = {
                  candidateUrl,
                  attempt,
                  error: identityCheck.error,
                  expected,
                  observed,
                };
                await writeCloudRepairLog({
                  event: "threads_user_mismatch",
                  accountId,
                  accountName: account.name,
                  ...lastDiagnostics,
                });
                continue;
              }
              verifiedThreadsUserId = identityCheck.userId;
              backfilledThreadsUserId = identityCheck.shouldBackfill;
            }
            const fingerprintError = gasFingerprintError(
              hc.data.tokenFingerprint,
              expectedFingerprint,
              observedUserId
            );
            if (fingerprintError) {
              lastHealthError = fingerprintError;
              lastDiagnostics = {
                candidateUrl,
                attempt,
                error: fingerprintError,
                expected,
                observed,
              };
              await writeCloudRepairLog({
                event: "token_fingerprint_mismatch",
                accountId,
                accountName: account.name,
                ...lastDiagnostics,
              });
              continue;
            }
            const tokenMeta = gasTokenMetaUpdate(hc.data);

            await prisma.account.update({
              where: { id: accountId },
              data: {
                gasWebAppUrl: candidateUrl,
                gasWebAppKey: webappKey,
                ...tokenMeta,
                ...(tokenMeta.tokenFingerprint ? {} : { tokenFingerprint: expectedFingerprint }),
                ...(verifiedThreadsUserId ? { threadsUserId: verifiedThreadsUserId } : {}),
                ...(sc.data?.username ? { threadsUsername: sc.data.username } : {}),
                cloudOffloadEnabled: shouldUseCloudQueue ? true : account.cloudOffloadEnabled,
              },
            });
            await writeCloudRepairLog({
              event: "repair_verified",
              accountId,
              accountName: account.name,
              candidateUrl,
              attempt,
              expected,
              observed,
              backfilledThreadsUserId,
              syncedTokenFingerprint:
                !!hc.data.tokenFingerprint && hc.data.tokenFingerprint !== expectedFingerprint,
            });

            // URL差し替え後に、既にGASで投稿済みになっている結果を先に取り込む。
            // その後に残った queued だけを新しいURLへ再送する。これで二重投稿を避ける。
            const syncResult = await syncOneAccount(accountId);
            const queueCutoff = new Date(Date.now() + 60_000);
            const pastQueuedCount = shouldUseCloudQueue
              ? await prisma.post.count({
                  where: {
                    accountId,
                    status: "queued",
                    publishAt: { not: null, lt: queueCutoff },
                  },
                })
              : 0;
            if (pastQueuedCount > 0) {
              await prisma.post.updateMany({
                where: {
                  accountId,
                  status: "queued",
                  publishAt: { not: null, lt: queueCutoff },
                },
                data: {
                  error:
                    "予約時刻を過ぎたため自動投稿を止めています。キュー画面の「時刻変更」で新しい日時に変更してください。",
                },
              });
            }
            const queuedPosts = shouldUseCloudQueue
              ? await prisma.post.findMany({
                  where: {
                    accountId,
                    status: "queued",
                    publishAt: { gte: queueCutoff },
                  },
                  orderBy: [{ publishAt: "asc" }, { sortOrder: "asc" }],
                })
              : [];
            let repairedQueued = 0;
            if (queuedPosts.length > 0) {
              const postsForGas: PushPostInput[] = queuedPosts.map((p) => ({
                webPostId: p.id,
                groupNo: p.groupNo,
                text: p.body,
                postType:
                  p.postType === "thread" ? "thread" : ("standalone" as const),
                publishAtJst: toJstString(p.publishAt!),
                memo: p.memo || undefined,
              }));
              await pushQueueAndVerifyOrThrow(
                { url: candidateUrl, key: webappKey },
                postsForGas
              );
              await prisma.post.updateMany({
                where: { id: { in: queuedPosts.map((p) => p.id) } },
                data: { executor: "gas" },
              });
              repairedQueued = queuedPosts.length;
            }

            const repairMessage =
              pastQueuedCount > 0
                ? `Google投稿を修復しました。未来の予約キューを確認済みです。過去時刻の予約 ${pastQueuedCount} 件は自動投稿せず、時刻変更待ちにしました。`
                : "Google投稿を修復しました。Google側のコード、自動実行、タイムゾーン、投稿用トークン、予約キューを確認済みです。";

            return NextResponse.json({
              ok: true,
              message: repairMessage,
              version: hc.data.version,
              hasTrigger: hc.data.hasTrigger,
              configured: hc.data.configured,
              scriptTimeZone: hc.data.scriptTimeZone,
              userId: verifiedThreadsUserId,
              backfilledThreadsUserId,
              gasWebAppUrl: candidateUrl,
              urlChanged: candidateUrl !== account.gasWebAppUrl,
              syncedResults: syncResult.ok ? syncResult.applied : 0,
              repairedQueued,
              skippedPastQueued: pastQueuedCount,
              verified: true,
            });
          }
        }

        return NextResponse.json(
          {
            ok: false,
            error:
              "Google側へコードは送信しましたが、予約投稿できる状態を確認できませんでした。予約はクラウドへ送らず止めます。GoogleログインとWeb App公開設定を確認して、もう一度「Google投稿を修復する」を押してください。" +
              "確認は約2分で打ち切りました。ボタンが固まったように見える状態は避けるため、時間を置いて再実行してください。" +
              (lastHealthError ? `（最後の確認結果: ${lastHealthError}）` : ""),
            diagnostics: lastDiagnostics,
          },
          { status: 502 }
        );
      } catch (e) {
        return NextResponse.json(
          { ok: false, error: e instanceof Error ? e.message : String(e) },
          { status: 500 }
        );
      } finally {
        if (repairLockHeld) {
          await prisma.appSetting.upsert({
            where: { key: repairLockKey },
            create: { key: repairLockKey, value: "false" },
            update: { value: "false" },
          });
        }
      }
    }

    // initialize: setConfig 実行 + Account にURL/Key保存
    if (action === "initialize") {
      const url = body.gasWebAppUrl as string;
      const key = body.gasWebAppKey as string;
      const spreadsheetId = (body.gasSpreadsheetId as string) || null;
      if (!url || !key) {
        return NextResponse.json(
          { error: "gasWebAppUrl と gasWebAppKey が必要です" },
          { status: 400 }
        );
      }
      const duplicate = await prisma.account.findFirst({
        where: { gasWebAppUrl: url, id: { not: accountId } },
        select: { name: true },
      });
      if (duplicate) {
        return NextResponse.json(
          {
            ok: false,
            error:
              `このGoogle連携は「${duplicate.name}」で使われています。` +
              "別アカウントのトークンで投稿される事故を避けるため、アカウントごとに別々のGoogle連携が必要です。自動セットアップをやり直してください。",
          },
          { status: 409 }
        );
      }
      const token = account.accessToken;
      if (!token) {
        return NextResponse.json(
          {
            error:
              "アカウントの Threads アクセストークンが未設定です。先にアカウント設定でトークンを保存してください",
          },
          { status: 400 }
        );
      }

      const r = await setConfig(
        { url, key },
        { token, webappKey: key, webappUrl: url }
      );
      if (!r.ok) {
        return NextResponse.json(
          { ok: false, error: r.error || "setConfig失敗" },
          { status: 502 }
        );
      }

      // タイムゾーン検証：スクリプトプロジェクトの timeZone が Asia/Tokyo でないと
      // processScheduledPosts が安全のため投稿を停止する（GAS側の防御）。
      // ここで弾いておかないと「設定完了→なのに投稿されない」事故になる。
      const scriptTz = r.data?.scriptTimeZone;
      if (scriptTz !== "Asia/Tokyo") {
        const tzLabel = scriptTz || "未返却";
        return NextResponse.json(
          {
            ok: false,
            error:
              `GASプロジェクトのタイムゾーンが ${tzLabel} になっています（Asia/Tokyo が必要）。` +
              `通常は appsscript.json で自動設定されますが、適用されなかったようです。` +
              `GASコードが古い場合もこのエラーになります。` +
              `Apps Scriptエディタの「プロジェクトの設定（⚙️）→ タイムゾーン」を ` +
              `Asia/Tokyo に変更してから、もう一度クラウドオフロードを設定してください。`,
            scriptTimeZone: scriptTz || null,
          },
          { status: 422 }
        );
      }
      const hc = await healthCheck({ url, key });
      if (!hc.ok || !hc.data) {
        return NextResponse.json(
          { ok: false, error: "GAS初期化後の確認に失敗しました: " + (hc.error || "不明") },
          { status: 502 }
        );
      }
      if (!isGasVersionSupported(hc.data.version)) {
        return NextResponse.json(
          { ok: false, error: gasVersionUpgradeMessage(hc.data.version) },
          { status: 422 }
        );
      }
      const observedUserId = hc.data.userId || r.data?.user_id || null;
      const identityCheck = await validateObservedThreadsUserId(
        {
          accountId,
          accountName: account.name,
          currentThreadsUserId: account.threadsUserId,
        },
        observedUserId
      );
      if (!identityCheck.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: identityCheck.error,
            expected: {
              userId: identityCheck.expectedUserId,
              tokenFingerprint: tokenFingerprintOf(token),
            },
            observed: {
              userId: identityCheck.observedUserId,
              tokenFingerprint: hc.data.tokenFingerprint || null,
              version: hc.data.version,
            },
          },
          { status: 409 }
        );
      }

      const tokenMeta = gasTokenMetaUpdate(hc.data);
      const updated = await prisma.account.update({
        where: { id: accountId },
        data: {
          gasWebAppUrl: url,
          gasWebAppKey: key,
          gasSpreadsheetId: spreadsheetId,
          ...tokenMeta,
          ...(tokenMeta.tokenFingerprint ? {} : { tokenFingerprint: tokenFingerprintOf(token) || undefined }),
          threadsUserId: identityCheck.userId,
          ...(r.data?.username ? { threadsUsername: r.data.username } : {}),
        },
      });
      return NextResponse.json({
        ok: true,
        message: "GAS側の初期化完了。「クラウドオフロードを有効化」で運用開始できます",
        userId: identityCheck.userId,
        username: r.data?.username,
        cloudOffloadEnabled: updated.cloudOffloadEnabled,
        scriptTimeZone: scriptTz,
        backfilledThreadsUserId: identityCheck.shouldBackfill,
      });
    }

    // enable: 有効化（migrationLock 経由で既存queuedをGASに転送）
    if (action === "enable") {
      const ep = endpointFromAccount(account);
      if (!ep) {
        return NextResponse.json(
          { error: "Google側の接続情報が見つかりません。設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。" },
          { status: 400 }
        );
      }
      // 疎通確認
      const hr = await healthCheck(ep);
      if (!hr.ok || !hr.data?.configured) {
        return NextResponse.json(
          { error: "GAS側の疎通NG: " + (hr.error || "configured=false") },
          { status: 502 }
        );
      }
      if (!isGasVersionSupported(hr.data.version)) {
        return NextResponse.json(
          { error: gasVersionUpgradeMessage(hr.data.version) },
          { status: 422 }
        );
      }
      if (hr.data.scriptTimeZone && hr.data.scriptTimeZone !== "Asia/Tokyo") {
        return NextResponse.json(
          {
            error:
              "Google側のタイムゾーンが Asia/Tokyo ではありません。設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。",
          },
          { status: 422 }
        );
      }
      if (!hr.data.hasTrigger) {
        return NextResponse.json(
          { error: "Google側の自動実行が見つかりません。設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。" },
          { status: 422 }
        );
      }
      const identityCheck = await validateObservedThreadsUserId(
        {
          accountId,
          accountName: account.name,
          currentThreadsUserId: account.threadsUserId,
        },
        hr.data.userId
      );
      if (!identityCheck.ok) {
        return NextResponse.json(
          {
            error: identityCheck.error,
            expected: {
              userId: identityCheck.expectedUserId,
              tokenFingerprint: tokenFingerprintOf(account.accessToken),
            },
            observed: {
              userId: identityCheck.observedUserId,
              tokenFingerprint: hr.data.tokenFingerprint || null,
              version: hr.data.version,
            },
          },
          { status: 409 }
        );
      }
      const tokenMeta = gasTokenMetaUpdate(hr.data);
      if (
        identityCheck.shouldBackfill ||
        tokenMeta.tokenFingerprint !== undefined ||
        tokenMeta.tokenExpiresAt !== undefined
      ) {
        await prisma.account.update({
          where: { id: accountId },
          data: {
            ...tokenMeta,
            ...(identityCheck.shouldBackfill ? { threadsUserId: identityCheck.userId } : {}),
          },
        });
      }

      try {
        const { result } = await withMigrationLock(async () => {
          // 未来の queued だけを現在のGASにpushする。
          // 過去時刻の予約は、PC復帰や修復直後の遅延投稿事故を避けるためGASへ送らずキューに残す。
          const queueCutoff = new Date(Date.now() + 60_000);
          const pastQueuedCount = await prisma.post.count({
            where: {
              accountId,
              status: "queued",
              publishAt: { not: null, lt: queueCutoff },
            },
          });
          if (pastQueuedCount > 0) {
            await prisma.post.updateMany({
              where: {
                accountId,
                status: "queued",
                publishAt: { not: null, lt: queueCutoff },
              },
              data: {
                error:
                  "予約時刻を過ぎたため自動投稿を止めています。キュー画面の「時刻変更」で新しい日時に変更してください。",
              },
            });
          }
          const queuedPosts = await prisma.post.findMany({
            where: { accountId, status: "queued", publishAt: { gte: queueCutoff } },
            orderBy: [{ publishAt: "asc" }, { sortOrder: "asc" }],
          });
          let transferred = 0;
          if (queuedPosts.length > 0) {
            const postsForGas: PushPostInput[] = queuedPosts.map((p) => ({
              webPostId: p.id,
              groupNo: p.groupNo,
              text: p.body,
              postType:
                p.postType === "thread" ? "thread" : ("standalone" as const),
              publishAtJst: toJstString(p.publishAt!),
              memo: p.memo || undefined,
            }));
            await pushQueueAndVerifyOrThrow(ep, postsForGas);
            await prisma.post.updateMany({
              where: { id: { in: queuedPosts.map((p) => p.id) } },
              data: { executor: "gas" },
            });
            transferred = queuedPosts.length;
          }
          await prisma.account.update({
            where: { id: accountId },
            data: { cloudOffloadEnabled: true },
          });
          return { transferred, skippedPastQueued: pastQueuedCount };
        });
        return NextResponse.json({
          ok: true,
          message:
            "クラウドオフロードを有効化しました" +
            (result.transferred > 0
              ? `。既存の ${result.transferred} 件のqueuedをGASに転送済`
              : "") +
            (result.skippedPastQueued > 0
              ? `。過去時刻の予約 ${result.skippedPastQueued} 件は自動投稿せず、時刻変更待ちにしました`
              : ""),
          transferred: result.transferred,
          skippedPastQueued: result.skippedPastQueued,
        });
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 500 }
        );
      }
    }

    // disable: 無効化（GAS側queuedをローカルに引き戻して安全に切替）
    if (action === "disable") {
      const ep = endpointFromAccount(account);
      const queuedGasCount = await prisma.post.count({
        where: { accountId, status: "queued", executor: "gas" },
      });

      // GAS側にqueued無し → 単純無効化
      if (queuedGasCount === 0) {
        await prisma.account.update({
          where: { id: accountId },
          data: { cloudOffloadEnabled: false },
        });
        return NextResponse.json({
          ok: true,
          message: "クラウドオフロードを無効化しました",
          transferredBack: 0,
        });
      }

      // queued あり → transferBack か force のどちらかが必要
      if (!body.transferBack && !body.force) {
        return NextResponse.json(
          {
            error: `GAS側に ${queuedGasCount} 件のqueued投稿が残っています。transferBack=true で Web側に引き戻し、force=true で強制無効化（GAS側はそのまま動作）`,
            queuedGasCount,
          },
          { status: 409 }
        );
      }

      try {
        const { result } = await withMigrationLock(async () => {
          let transferredBack = 0;
          if (body.transferBack && ep) {
            // GAS側のqueued分をキャンセル → executor="local" に書き戻し
            const gasPosts = await prisma.post.findMany({
              where: { accountId, status: "queued", executor: "gas" },
            });
            for (const gp of gasPosts) {
              const cr = await cancelByPostId(ep, gp.id);
              if (!cr.ok) {
                console.warn(
                  `[/api/cloud/setup disable] cancel失敗 (postId=${gp.id}): ${cr.error}`
                );
              }
            }
            await prisma.post.updateMany({
              where: { accountId, status: "queued", executor: "gas" },
              data: { executor: "local" },
            });
            transferredBack = gasPosts.length;
          }
          await prisma.account.update({
            where: { id: accountId },
            data: { cloudOffloadEnabled: false },
          });
          return { transferredBack };
        });

        return NextResponse.json({
          ok: true,
          message:
            "クラウドオフロードを無効化しました" +
            (result.transferredBack > 0
              ? `（${result.transferredBack} 件をWeb側に引き戻し）`
              : "（強制無効化）"),
          transferredBack: result.transferredBack,
        });
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(
      { error: `unknown action: ${action}` },
      { status: 400 }
    );
  } catch (e) {
    console.error("[/api/cloud/setup] error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
