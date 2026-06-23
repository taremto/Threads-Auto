/**
 * 統合テスト — Mock GAS サーバを相手に、ハイブリッド機構を実通信で検証する。
 *
 * 起動順:
 *   1. node tests/mock-gas-server.mjs &   # ポート5555で起動
 *   2. DATABASE_URL=file:./test.db npx prisma migrate deploy
 *   3. DATABASE_URL=file:./test.db npx tsx tests/integration.test.ts
 *
 * 検証ポイント:
 *   - healthCheck / setConfig / pushQueue / pullResults / ackResults / cancel / update / disable
 *   - executor フィルタ (scheduler.processQueue が gas executor を拾わない)
 *   - migrationLock (切替中は scheduler が早期return)
 *   - enable で既存queued(local) が GAS に転送される
 *   - disable transferBack で queued(gas) がローカルに引き戻される
 */

import { PrismaClient } from "@prisma/client";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cancelByPostId,
  healthCheck,
  pushQueue,
  setConfig,
  toJstString,
  updateByPostId,
  verifyQueueByPostIds,
  pullResults,
  ackResults,
  type GasEndpoint,
  type PushPostInput,
} from "../src/lib/gas-bridge.js";
import { syncOneAccount } from "../src/lib/gas-sync.js";
import { processQueue } from "../src/lib/scheduler.js";
import { POST as cloudSetupPost } from "../src/app/api/cloud/setup/route.js";

const MOCK_URL = "http://localhost:5555/exec";
const MOCK_BACKDOOR = "http://localhost:5555";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    failures.push(msg);
    fail++;
  }
}

async function resetMock() {
  await fetch(`${MOCK_BACKDOOR}/__reset`, { method: "POST" });
}
async function getMockState() {
  const r = await fetch(`${MOCK_BACKDOOR}/__state`);
  return r.json();
}
async function simulatePost(webPostId: string, threadsPostId?: string) {
  const r = await fetch(`${MOCK_BACKDOOR}/__simulate_post`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ webPostId, threadsPostId }),
  });
  return r.json();
}
async function simulateError(webPostId: string, error: string) {
  const r = await fetch(`${MOCK_BACKDOOR}/__simulate_error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ webPostId, error }),
  });
  return r.json();
}
async function simulateNextSetConfigToken(token: string) {
  const r = await fetch(`${MOCK_BACKDOOR}/__next_set_config_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return r.json();
}

function tokenFingerprint(token: string | null | undefined) {
  if (!token || token.length < 12) return null;
  return token.substring(0, 8) + "…" + token.substring(token.length - 4);
}

async function withFakeClasp<T>(fn: () => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "mock-clasp-"));
  const binPath = path.join(binDir, "clasp");
  await writeFile(
    binPath,
    `#!/usr/bin/env bash
set -e
case "$1" in
  --version) echo "2.4.2";;
  login) echo "Logged in";;
  push) ;;
  version) echo "Created version 1";;
  deploy) ;;
  deployments) ;;
  *) ;;
esac
`,
    "utf8"
  );
  await chmod(binPath, 0o755);
  const oldPath = process.env.PATH || "";
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

async function callCloudSetup(body: Record<string, unknown>) {
  const res = await cloudSetupPost(
    new Request("http://localhost/api/cloud/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  const data = await res.json();
  return { res, data };
}

async function resetDb() {
  await prisma.appSetting.deleteMany({});
  await prisma.post.deleteMany({});
  await prisma.knowledge.deleteMany({});
  await prisma.account.deleteMany({});
}

// ============================================
// テストシナリオ
// ============================================

async function testHealthCheckAndSetConfig() {
  console.log("\n[1] healthCheck + setConfig");
  const ep: GasEndpoint = { url: MOCK_URL, key: "TESTKEY_INIT" };

  const hc1 = await healthCheck(ep);
  assert(hc1.ok, "healthCheck 疎通成功");
  assert(hc1.data?.configured === false, "未設定状態を正しく返す");

  const cfg = await setConfig(
    { url: MOCK_URL },
    { token: "test_token_abcdefghijklmn1234567890", webappKey: "MYNEWKEY", webappUrl: MOCK_URL }
  );
  assert(cfg.ok, "setConfig 成功");
  assert(typeof cfg.data?.user_id === "string", "user_id 返却");

  // 以降は新keyで認証
  const ep2: GasEndpoint = { url: MOCK_URL, key: "MYNEWKEY" };
  const hc2 = await healthCheck(ep2);
  assert(hc2.ok && hc2.data?.configured === true, "setConfig後 configured=true");
  assert(hc2.data?.tokenFingerprint != null, "tokenFingerprint 返却");
  assert(hc2.data?.hasTokenRefreshTrigger === true, "トークン自動更新トリガーあり");
  assert(hc2.data?.tokenStatus === "ok", "tokenStatus=ok 返却");
  assert(hc2.data?.tokenExpiresAt != null, "tokenExpiresAt 返却");

  // 旧keyは弾かれる
  const hcWrong = await healthCheck({ url: MOCK_URL, key: "WRONG" });
  // healthCheck はキー検証なしなので通る — 仕様確認
  assert(hcWrong.ok, "healthCheckはkey検証なし設計（疎通確認のため）");

  // pushQueueは認証必須
  const pushWrong = await pushQueue({ url: MOCK_URL, key: "WRONG" }, [
    { webPostId: "x", groupNo: 1, text: "t", postType: "standalone", publishAtJst: "2026-05-09T10:00" },
  ]);
  assert(!pushWrong.ok, "誤ったkeyでpushQueueは失敗");
  assert(pushWrong.error?.includes("認証"), "認証エラーメッセージ");
}

async function testPushAndPullCycle() {
  console.log("\n[2] pushQueue → simulate投稿 → pullResults → ackResults");
  await resetMock();

  // setConfig を先に
  await setConfig(
    { url: MOCK_URL },
    { token: "test_token_abcdefghijklmn1234567890", webappKey: "K2", webappUrl: MOCK_URL }
  );
  const ep2: GasEndpoint = { url: MOCK_URL, key: "K2" };

  // pushQueue 3件
  const posts: PushPostInput[] = [
    {
      webPostId: "post_a",
      groupNo: 1,
      text: "テスト投稿A",
      postType: "standalone",
      publishAtJst: "2026-05-09T10:00",
    },
    {
      webPostId: "post_b",
      groupNo: 2,
      text: "■1\nスレッド1本目",
      postType: "thread",
      publishAtJst: "2026-05-09T11:00",
    },
    {
      webPostId: "post_c",
      groupNo: 2,
      text: "■2\nスレッド2本目",
      postType: "thread",
      publishAtJst: "2026-05-09T11:00",
    },
  ];
  const r1 = await pushQueue(ep2, posts);
  assert(r1.ok, "pushQueue 成功");
  assert(r1.data?.rows === 3, "3件追加");
  const verify = await verifyQueueByPostIds(ep2, posts.map((p) => p.webPostId));
  assert(verify.ok, "verifyQueueByPostIds 成功");
  assert(verify.data?.missing.length === 0, "push後のmissing 0件");
  assert(verify.data?.rows.every((r) => r.status === "待機中"), "push後は全件待機中");

  // 重複push は同じwebPostIdの行を上書きする
  const dup = await pushQueue(ep2, [posts[0]]);
  assert(dup.ok && dup.data?.rows === 1, "重複push は上書き成功");

  // 投稿前 pullResults は空
  const pull1 = await pullResults(ep2);
  assert(pull1.ok && pull1.data?.count === 0, "投稿前 pullResults は空");

  // post_a だけ投稿成功シミュレート
  await simulatePost("post_a");
  const postedPush = await pushQueue(ep2, [posts[0]]);
  assert(!postedPush.ok, "投稿済みwebPostIdの再pushは拒否");

  const pull2 = await pullResults(ep2);
  assert(pull2.ok && pull2.data?.count === 1, "post_a のみ pullResults で取れる");
  assert(pull2.data?.results[0].webPostId === "post_a", "正しいwebPostId");
  assert(pull2.data?.results[0].status === "posted", "status=posted");
  assert(typeof pull2.data?.results[0].threadsPostId === "string", "threadsPostId 文字列");

  // ack
  const ackR = await ackResults(ep2, ["post_a"]);
  assert(ackR.ok && ackR.data?.acked === 1, "ackResults 1件");

  // ack後 同じpullは空
  const pull3 = await pullResults(ep2);
  assert(pull3.ok && pull3.data?.count === 0, "ack後 pullResults は空");

  // post_b にエラー
  await simulateError("post_b", "ネットワーク失敗");
  const pull4 = await pullResults(ep2);
  assert(pull4.ok && pull4.data?.count === 1, "エラー1件 pull");
  assert(pull4.data?.results[0].status === "error", "status=error");
  assert(pull4.data?.recentErrorCount24h === 1, "24h以内エラー1件");
}

async function testCancelAndUpdate() {
  console.log("\n[3] cancelByPostId + updateByPostId");
  await resetMock();
  await setConfig(
    { url: MOCK_URL },
    { token: "test_token_abcdefghijklmn1234567890", webappKey: "K3", webappUrl: MOCK_URL }
  );
  const ep: GasEndpoint = { url: MOCK_URL, key: "K3" };

  await pushQueue(ep, [
    {
      webPostId: "edit_target",
      groupNo: 1,
      text: "元の本文",
      postType: "standalone",
      publishAtJst: "2026-05-10T09:00",
    },
  ]);

  // 編集
  const upd = await updateByPostId(ep, {
    webPostId: "edit_target",
    text: "新しい本文",
    publishAtJst: "2026-05-10T10:00",
  });
  assert(upd.ok, "updateByPostId 成功");
  const st1 = await getMockState();
  const editedRow = st1.rows.find((r: { webPostId: string }) => r.webPostId === "edit_target");
  assert(editedRow.text === "新しい本文", "本文更新反映");
  assert(editedRow.publishAtJst === "2026-05-10T10:00", "publishAt更新反映");

  // 投稿済の編集は失敗
  await simulatePost("edit_target");
  const updFail = await updateByPostId(ep, { webPostId: "edit_target", text: "後出し編集" });
  assert(!updFail.ok && updFail.error?.includes("投稿済"), "投稿済 update 拒否");

  // cancelByPostId
  await pushQueue(ep, [
    {
      webPostId: "cancel_target",
      groupNo: 2,
      text: "削除予定",
      postType: "standalone",
      publishAtJst: "2026-05-10T15:00",
    },
  ]);
  const cancel = await cancelByPostId(ep, "cancel_target");
  assert(cancel.ok, "cancelByPostId 成功");
  const st2 = await getMockState();
  const cancelledRow = st2.rows.find((r: { webPostId: string }) => r.webPostId === "cancel_target");
  assert(cancelledRow.status === "下書き", "ステータス下書き化");
}

async function testEnableTransfersExistingQueued() {
  console.log("\n[4] enable時の既存queued転送 (gas-bridge直接呼び出しで再現)");
  await resetMock();
  await resetDb();

  // mock setConfig
  await setConfig(
    { url: MOCK_URL },
    { token: "test_token_abcdefghijklmn1234567890", webappKey: "K4", webappUrl: MOCK_URL }
  );

  // Account作成: cloudOffloadEnabled=false でURL/Keyだけ持つ
  const acc = await prisma.account.create({
    data: {
      name: "test-acc",
      threadsUserId: "1",
      accessToken: "test_token_abcdefghijklmn1234567890",
      cloudOffloadEnabled: false,
      gasWebAppUrl: MOCK_URL,
      gasWebAppKey: "K4",
    },
  });

  // 既存queued(local) を3件作成
  const futureAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 明日
  for (let i = 0; i < 3; i++) {
    await prisma.post.create({
      data: {
        accountId: acc.id,
        groupNo: i + 100,
        body: `existing post ${i}`,
        postType: "standalone",
        status: "queued",
        executor: "local",
        publishAt: new Date(futureAt.getTime() + i * 65 * 60 * 1000),
        sortOrder: i,
      },
    });
  }
  const beforeLocal = await prisma.post.count({
    where: { accountId: acc.id, executor: "local", status: "queued" },
  });
  assert(beforeLocal === 3, "事前 local queued 3件");

  // enable相当: GASにpush + DB更新（routeのロジックを直接実行）
  const localQueued = await prisma.post.findMany({
    where: { accountId: acc.id, status: "queued", executor: "local" },
  });
  const ep: GasEndpoint = { url: MOCK_URL, key: "K4" };
  const postsForGas: PushPostInput[] = localQueued.map((p) => ({
    webPostId: p.id,
    groupNo: p.groupNo,
    text: p.body,
    postType: p.postType === "thread" ? "thread" : "standalone",
    publishAtJst: toJstString(p.publishAt!),
  }));
  const pr = await pushQueue(ep, postsForGas);
  assert(pr.ok, "既存queuedをGASに転送成功");

  await prisma.post.updateMany({
    where: { id: { in: localQueued.map((p) => p.id) } },
    data: { executor: "gas" },
  });
  await prisma.account.update({
    where: { id: acc.id },
    data: { cloudOffloadEnabled: true },
  });

  const afterLocal = await prisma.post.count({
    where: { accountId: acc.id, executor: "local", status: "queued" },
  });
  const afterGas = await prisma.post.count({
    where: { accountId: acc.id, executor: "gas", status: "queued" },
  });
  assert(afterLocal === 0, "転送後 local queued 0件");
  assert(afterGas === 3, "転送後 gas queued 3件");

  const mockState = await getMockState();
  assert(mockState.rows.length === 3, "Mock GAS側にも3行");
}

async function testEnableSkipsPastQueuedViaRoute() {
  console.log("\n[4.5] enable API は過去時刻のqueuedをGASへ送らず時刻変更待ちにする");
  await resetMock();
  await resetDb();
  const cfg = await setConfig(
    { url: MOCK_URL },
    { token: "test_token_abcdefghijklmn1234567890", webappKey: "K45", webappUrl: MOCK_URL }
  );
  const configuredUserId = cfg.data?.user_id || "missing";

  const acc = await prisma.account.create({
    data: {
      name: "enable-route-test",
      threadsUserId: configuredUserId,
      accessToken: "test_token_abcdefghijklmn1234567890",
      cloudOffloadEnabled: false,
      gasWebAppUrl: MOCK_URL,
      gasWebAppKey: "K45",
    },
  });

  const pastPost = await prisma.post.create({
    data: {
      accountId: acc.id,
      groupNo: 1,
      body: "past queued",
      postType: "standalone",
      status: "queued",
      executor: "local",
      publishAt: new Date(Date.now() - 5 * 60 * 1000),
    },
  });
  const futurePost = await prisma.post.create({
    data: {
      accountId: acc.id,
      groupNo: 2,
      body: "future queued",
      postType: "standalone",
      status: "queued",
      executor: "local",
      publishAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    },
  });

  const { res, data } = await callCloudSetup({
    action: "enable",
    accountId: acc.id,
  });
  assert(res.status === 200 && data.ok === true, "enable API 成功");
  assert(data.transferred === 1, "未来予約だけ1件GASへ転送");
  assert(data.skippedPastQueued === 1, "過去予約1件は転送スキップ");

  const updatedPast = await prisma.post.findUnique({ where: { id: pastPost.id } });
  const updatedFuture = await prisma.post.findUnique({ where: { id: futurePost.id } });
  assert(updatedPast?.status === "queued", "過去予約はqueuedのまま残る");
  assert(updatedPast?.executor === "local", "過去予約はGAS担当に切り替えない");
  assert(
    updatedPast?.error?.includes("予約時刻を過ぎたため") === true,
    "過去予約には時刻変更案内が入る"
  );
  assert(updatedFuture?.executor === "gas", "未来予約はGAS担当に切り替わる");

  const mockState = await getMockState();
  assert(mockState.rows.length === 1, "Mock GAS側には未来予約だけ1行");
  assert(mockState.rows[0].webPostId === futurePost.id, "GASへ送ったのは未来予約");
}

async function testEnableBackfillsMissingThreadsUserId() {
  console.log("\n[4.6] enable API はthreadsUserId空欄をGASのuserIdで補完する");
  await resetMock();
  await resetDb();
  const cfg = await setConfig(
    { url: MOCK_URL },
    { token: "test_token_user_backfill_abcdefghijklmn1234567890", webappKey: "K46", webappUrl: MOCK_URL }
  );

  const acc = await prisma.account.create({
    data: {
      name: "enable-backfill-test",
      threadsUserId: null,
      accessToken: "test_token_user_backfill_abcdefghijklmn1234567890",
      cloudOffloadEnabled: false,
      gasWebAppUrl: MOCK_URL,
      gasWebAppKey: "K46",
    },
  });

  const { res, data } = await callCloudSetup({
    action: "enable",
    accountId: acc.id,
  });
  assert(res.status === 200 && data.ok === true, "enable API 成功");
  const updated = await prisma.account.findUnique({ where: { id: acc.id } });
  assert(updated?.threadsUserId === cfg.data?.user_id, "GASのuserIdでthreadsUserIdを補完");
}

async function testEnableRejectsThreadsUserMismatch() {
  console.log("\n[4.7] enable API はGASとWebのThreads userId不一致を拒否する");
  await resetMock();
  await resetDb();
  await setConfig(
    { url: MOCK_URL },
    { token: "test_token_user_actual_abcdefghijklmn1234567890", webappKey: "K47", webappUrl: MOCK_URL }
  );

  const acc = await prisma.account.create({
    data: {
      name: "enable-mismatch-test",
      threadsUserId: "different_user",
      accessToken: "test_token_user_actual_abcdefghijklmn1234567890",
      cloudOffloadEnabled: false,
      gasWebAppUrl: MOCK_URL,
      gasWebAppKey: "K47",
    },
  });

  const { res, data } = await callCloudSetup({
    action: "enable",
    accountId: acc.id,
  });
  assert(res.status === 409, "userId不一致は409で拒否");
  assert(String(data.error).includes("取り違え防止"), "取り違え防止エラーを返す");
  const updated = await prisma.account.findUnique({ where: { id: acc.id } });
  assert(updated?.cloudOffloadEnabled === false, "拒否時はcloudOffloadEnabledを変更しない");
}

async function testRepairAllowsRefreshedGasTokenFingerprint() {
  console.log("\n[4.8] repair API は同一userIdのGASリフレッシュ後fingerprint差分を同期して通す");
  await resetMock();
  await resetDb();

  const oldToken = "test_token_user_ranka";
  const refreshedToken = "refreshed_token_same_ranka_generation_ZDZD";
  await simulateNextSetConfigToken(refreshedToken);

  const acc = await prisma.account.create({
    data: {
      name: "repair-refreshed-token-test",
      threadsUserId: null,
      accessToken: oldToken,
      tokenFingerprint: tokenFingerprint(oldToken),
      cloudOffloadEnabled: true,
      gasWebAppUrl: MOCK_URL,
      gasWebAppKey: "K48",
    },
  });
  const gasDeployDir = path.join(process.cwd(), "gas-deploy", acc.id);
  await mkdir(gasDeployDir, { recursive: true });
  await writeFile(
    path.join(gasDeployDir, ".clasp.json"),
    JSON.stringify({ scriptId: "mock-script-id" }, null, 2),
    "utf8"
  );

  await withFakeClasp(async () => {
    const { res, data } = await callCloudSetup({
      action: "repairCloudPosting",
      accountId: acc.id,
    });
    assert(res.status === 200 && data.ok === true, "repair API 成功");
    assert(data.userId === "ranka", "GASのuserIdで同一アカウントを確認");
    assert(data.backfilledThreadsUserId === true, "threadsUserId を補完");
  });

  const updated = await prisma.account.findUnique({ where: { id: acc.id } });
  assert(updated?.threadsUserId === "ranka", "DBにthreadsUserIdを保存");
  assert(
    updated?.tokenFingerprint === tokenFingerprint(refreshedToken),
    "DBのtokenFingerprintをGAS側の新世代fingerprintへ同期"
  );
  assert(updated?.tokenExpiresAt instanceof Date, "DBのtokenExpiresAtをGAS側から同期");
}

async function testSchedulerExecutorFilter() {
  console.log("\n[5] scheduler.processQueue が executor='gas' を拾わないこと");
  await resetDb();

  const acc = await prisma.account.create({
    data: {
      name: "scheduler-filter-test",
      threadsUserId: "5",
      accessToken: "test_token_abcdefghijklmn1234567890",
      cloudOffloadEnabled: true,
      gasWebAppUrl: MOCK_URL,
      gasWebAppKey: "K5",
    },
  });

  const futureAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  for (let i = 0; i < 3; i++) {
    await prisma.post.create({
      data: {
        accountId: acc.id,
        groupNo: i + 500,
        body: `gas queued ${i}`,
        postType: "standalone",
        status: "queued",
        executor: "gas",
        publishAt: new Date(futureAt.getTime() + i * 65 * 60 * 1000),
        retryCount: 0,
      },
    });
  }

  const pastAt = new Date(Date.now() - 5 * 60 * 1000); // 5分前
  const localPost = await prisma.post.create({
    data: {
      accountId: acc.id,
      groupNo: 999,
      body: "local past post",
      postType: "standalone",
      status: "queued",
      executor: "local",
      publishAt: pastAt,
    },
  });

  // scheduler を実行（accessToken=test_token で実投稿は失敗するはずだが、
  // 重要なのは「拾われるのが localの1件のみ」かどうか）
  const beforeStatus = await prisma.post.findMany({
    where: { accountId: acc.id, status: "queued" },
    select: { id: true, executor: true, status: true, retryCount: true },
  });
  const localQueuedCount = beforeStatus.filter((p) => p.executor === "local").length;
  const gasQueuedCount = beforeStatus.filter((p) => p.executor === "gas").length;
  assert(localQueuedCount === 1, "実行前 local queued 1件");
  assert(gasQueuedCount === 3, "実行前 gas queued 3件");

  // processQueue の中で publishThreadなどが呼ばれて実APIエラーが出るはずだが、
  // 期待挙動: gas executor の3件は touch されない（status=queued のまま、retryCount=0 のまま）
  await processQueue();

  const afterGas = await prisma.post.findMany({
    where: { accountId: acc.id, executor: "gas" },
    select: { status: true, retryCount: true },
  });
  assert(
    afterGas.every((p) => p.status === "queued" && p.retryCount === 0),
    "executor='gas' の3件は scheduler から完全に touched されていない"
  );

  // local の方は過去時刻なので、投稿せず queued のまま時刻変更待ちにする
  const afterLocal = await prisma.post.findUnique({ where: { id: localPost.id } });
  assert(afterLocal?.status === "queued", "過去時刻のlocal queuedは投稿せずキューに残る");
  assert(
    afterLocal?.error?.includes("予約時刻を過ぎたため") === true,
    "過去時刻のlocal queuedには時刻変更案内が入る"
  );
  console.log(
    `    (参考) local Post 状態: status=${afterLocal?.status}, retryCount=${afterLocal?.retryCount}, error=${afterLocal?.error?.slice(0, 80)}`
  );
}

async function testMigrationLockSkipsScheduler() {
  console.log("\n[6] migrationLock 中は scheduler が早期return する");
  // ロックON
  await prisma.appSetting.upsert({
    where: { key: "migrationLock" },
    create: { key: "migrationLock", value: "true" },
    update: { value: "true" },
  });

  const acc = await prisma.account.findFirst();
  if (!acc) {
    assert(false, "アカウント未作成");
    return;
  }
  // local queued をもう1件追加
  const past = new Date(Date.now() - 60 * 1000);
  const lockTestPost = await prisma.post.create({
    data: {
      accountId: acc.id,
      groupNo: 12345,
      body: "lock test post",
      postType: "standalone",
      status: "queued",
      executor: "local",
      publishAt: past,
      retryCount: 0,
    },
  });

  await processQueue(); // ロック中なので早期return される想定

  const after = await prisma.post.findUnique({ where: { id: lockTestPost.id } });
  assert(
    after?.status === "queued" && after?.retryCount === 0,
    "ロック中は status/retryCount 不変"
  );

  // ロック解除
  await prisma.appSetting.update({
    where: { key: "migrationLock" },
    data: { value: "false" },
  });
}

async function testGasSyncEndToEnd() {
  console.log("\n[7] gas-sync.syncOneAccount で投稿結果が SQLite に取り込まれる");
  await resetMock();
  await resetDb();
  await setConfig(
    { url: MOCK_URL },
    { token: "test_token_abcdefghijklmn1234567890", webappKey: "K7", webappUrl: MOCK_URL }
  );

  const acc = await prisma.account.create({
    data: {
      name: "sync-test",
      threadsUserId: "2",
      accessToken: "test_token_abcdefghijklmn1234567890",
      cloudOffloadEnabled: true,
      gasWebAppUrl: MOCK_URL,
      gasWebAppKey: "K7",
    },
  });

  // SQLiteに executor=gas の Post を1件作成（GAS転送済みを想定）
  const sourcePost = await prisma.post.create({
    data: {
      accountId: acc.id,
      groupNo: 1,
      body: "sync test body",
      postType: "standalone",
      status: "queued",
      executor: "gas",
      publishAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  // Mock GASにも対応行を入れる
  const ep: GasEndpoint = { url: MOCK_URL, key: "K7" };
  await pushQueue(ep, [
    {
      webPostId: sourcePost.id,
      groupNo: 1,
      text: sourcePost.body,
      postType: "standalone",
      publishAtJst: toJstString(sourcePost.publishAt!),
    },
  ]);

  // 投稿成功シミュレート
  await simulatePost(sourcePost.id, "1234567890123456789");

  // syncOneAccount を実行
  const result = await syncOneAccount(acc.id);
  assert(result.ok, "syncOneAccount 成功");
  assert(result.fetched === 1, "1件取得");
  assert(result.applied === 1, "DB反映1件");
  assert(result.acked === 1, "ack1件");

  // SQLite側で posted になっているか
  const updatedPost = await prisma.post.findUnique({ where: { id: sourcePost.id } });
  assert(updatedPost?.status === "posted", "status=posted");
  assert(updatedPost?.threadsPostId === "1234567890123456789", "threadsPostId 反映");
  assert(updatedPost?.postedAt != null, "postedAt 設定");

  // 2回目のsync は0件取得（ack済のため）
  const result2 = await syncOneAccount(acc.id);
  assert(result2.fetched === 0, "ack済はpullされない");

  // Account の lastSyncedAt と tokenFingerprint, tokenExpiresAt が更新されているか
  const updatedAcc = await prisma.account.findUnique({ where: { id: acc.id } });
  assert(updatedAcc?.lastSyncedAt != null, "lastSyncedAt 更新");
  assert(updatedAcc?.tokenFingerprint != null, "tokenFingerprint 同期");
  assert(updatedAcc?.tokenExpiresAt != null, "tokenExpiresAt 同期");
}

async function testDisableTransferBack() {
  console.log("\n[8] disable transferBack で GAS queued がローカルに引き戻される");
  await resetMock();
  await resetDb();
  await setConfig(
    { url: MOCK_URL },
    { token: "test_token_abcdefghijklmn1234567890", webappKey: "K8", webappUrl: MOCK_URL }
  );

  const acc = await prisma.account.create({
    data: {
      name: "disable-test",
      threadsUserId: "3",
      accessToken: "test_token_abcdefghijklmn1234567890",
      cloudOffloadEnabled: true,
      gasWebAppUrl: MOCK_URL,
      gasWebAppKey: "K8",
    },
  });

  // executor=gas の queued を2件
  const ep: GasEndpoint = { url: MOCK_URL, key: "K8" };
  for (let i = 0; i < 2; i++) {
    const p = await prisma.post.create({
      data: {
        accountId: acc.id,
        groupNo: 200 + i,
        body: `disable target ${i}`,
        postType: "standalone",
        status: "queued",
        executor: "gas",
        publishAt: new Date(Date.now() + (i + 1) * 60 * 60 * 1000),
      },
    });
    await pushQueue(ep, [
      {
        webPostId: p.id,
        groupNo: p.groupNo,
        text: p.body,
        postType: "standalone",
        publishAtJst: toJstString(p.publishAt!),
      },
    ]);
  }

  // disable transferBack 相当: GASの queued をキャンセル + DB を local に戻す
  const gasPosts = await prisma.post.findMany({
    where: { accountId: acc.id, status: "queued", executor: "gas" },
  });
  for (const gp of gasPosts) {
    await cancelByPostId(ep, gp.id);
  }
  await prisma.post.updateMany({
    where: { accountId: acc.id, status: "queued", executor: "gas" },
    data: { executor: "local" },
  });
  await prisma.account.update({
    where: { id: acc.id },
    data: { cloudOffloadEnabled: false },
  });

  const localCount = await prisma.post.count({
    where: { accountId: acc.id, executor: "local", status: "queued" },
  });
  const gasCount = await prisma.post.count({
    where: { accountId: acc.id, executor: "gas", status: "queued" },
  });
  assert(localCount === 2, "ローカル2件に戻った");
  assert(gasCount === 0, "GAS executor 0件");

  // Mock GAS側のシートはキャンセルされているか
  const mockState = await getMockState();
  const cancelled = mockState.rows.filter((r: { status: string }) => r.status === "下書き");
  assert(cancelled.length === 2, "Mock GAS側で2件 下書き化");
}

async function testTzConversion() {
  console.log("\n[9] toJstString のTZ変換");
  // 2026-05-09 10:00 JST = 2026-05-09 01:00 UTC
  const utc = new Date("2026-05-09T01:00:00Z");
  const jst = toJstString(utc);
  assert(jst === "2026-05-09T10:00", `UTC→JST変換 (got: ${jst})`);

  // 日付跨ぎ: 2026-05-09 23:30 UTC → 2026-05-10 08:30 JST
  const utc2 = new Date("2026-05-09T23:30:00Z");
  const jst2 = toJstString(utc2);
  assert(jst2 === "2026-05-10T08:30", `日付跨ぎTZ変換 (got: ${jst2})`);

  // 秒は丸められる
  const utc3 = new Date("2026-05-09T01:00:45Z");
  const jst3 = toJstString(utc3);
  assert(jst3 === "2026-05-09T10:00", `秒丸め (got: ${jst3})`);
}

// ============================================
// メイン
// ============================================
async function main() {
  console.log("============================================");
  console.log("  Hybrid Cloud Offload Integration Test");
  console.log("============================================");

  // Mock GAS が立ち上がっているか確認
  try {
    const r = await fetch(`${MOCK_BACKDOOR}/__state`);
    if (!r.ok) throw new Error("mock-gas not responding");
  } catch {
    console.error("❌ Mock GAS server not reachable on", MOCK_URL);
    console.error("   起動: node tests/mock-gas-server.mjs &");
    process.exit(1);
  }

  await resetDb();

  await testHealthCheckAndSetConfig();
  await testPushAndPullCycle();
  await testCancelAndUpdate();
  await testEnableTransfersExistingQueued();
  await testEnableSkipsPastQueuedViaRoute();
  await testEnableBackfillsMissingThreadsUserId();
  await testEnableRejectsThreadsUserMismatch();
  await testRepairAllowsRefreshedGasTokenFingerprint();
  await testSchedulerExecutorFilter();
  await testMigrationLockSkipsScheduler();
  await testGasSyncEndToEnd();
  await testDisableTransferBack();
  await testTzConversion();

  console.log("\n============================================");
  console.log(`  ✅ ${pass} passed   ❌ ${fail} failed`);
  console.log("============================================");
  if (fail > 0) {
    console.log("\n失敗したアサーション:");
    failures.forEach((f) => console.log("  -", f));
    process.exit(1);
  }
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("テスト実行中に例外:", e);
  process.exit(1);
});
