import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  REQUIRED_GAS_VERSION,
  isGasVersionSupported,
  toJstString,
} from "../src/lib/gas-bridge";
import { buildJstSlots } from "../src/lib/schedule";

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3011";

let pass = 0;

async function test(name: string, fn: () => Promise<void>) {
  await fn();
  pass++;
  console.log(`  ✓ ${name}`);
}

async function jsonFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

function assertRecord(v: unknown): asserts v is Record<string, unknown> {
  assert.equal(typeof v, "object");
  assert.notEqual(v, null);
}

async function resetDb() {
  await prisma.appSetting.deleteMany({});
  await prisma.post.deleteMany({});
  await prisma.knowledge.deleteMany({});
  await prisma.account.deleteMany({});
}

async function createAccount(i: number, data: Partial<{
  accessToken: string | null;
  postingHours: string;
  postsPerDay: number;
  scheduleJitterMinutes: number;
  cloudOffloadEnabled: boolean;
}> = {}) {
  return prisma.account.create({
    data: {
      name: `検証アカウント${i}`,
      threadsUserId: `100000${i}`,
      threadsUsername: `check_${i}`,
      accessToken:
        "accessToken" in data
          ? data.accessToken ?? null
          : `token_${i}_abcdefghijklmnopqrstuvwxyz`,
      postingHours: data.postingHours ?? "[6,12,18,21]",
      postsPerDay: data.postsPerDay ?? 4,
      scheduleJitterMinutes: data.scheduleJitterMinutes ?? 0,
      cloudOffloadEnabled: data.cloudOffloadEnabled ?? false,
    },
  });
}

async function createDraft(accountId: string, groupNo: number, sortOrder = 0) {
  return prisma.post.create({
    data: {
      accountId,
      groupNo,
      sortOrder,
      body: `検証投稿 ${groupNo}-${sortOrder}`,
      postType: "standalone",
      charCount: 12,
      status: "draft",
    },
  });
}

function futureDate(minutesFromNow: number) {
  const d = new Date(Date.now() + minutesFromNow * 60 * 1000);
  d.setSeconds(0, 0);
  return d;
}

console.log("============================================");
console.log("  Final User-Flow Check");
console.log("============================================");

async function main() {
  await resetDb();

  await test("トップページがHTTP 200で開ける", async () => {
    const res = await fetch(BASE_URL);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Threads Auto|__next/i);
  });

  await test("古いGASコードを安全に検出できる", async () => {
    assert.equal(REQUIRED_GAS_VERSION, "webapp-v1.1.9");
    assert.equal(isGasVersionSupported("webapp-v1.0.0"), false);
    assert.equal(isGasVersionSupported("webapp-v1.1.3"), false);
    assert.equal(isGasVersionSupported("webapp-v1.1.4"), false);
    assert.equal(isGasVersionSupported("webapp-v1.1.5"), false);
    assert.equal(isGasVersionSupported("webapp-v1.1.6"), false);
    assert.equal(isGasVersionSupported("webapp-v1.1.8"), false);
    assert.equal(isGasVersionSupported("webapp-v1.1.9"), true);
    assert.equal(isGasVersionSupported("webapp-v1.2.0"), true);
    assert.equal(isGasVersionSupported(null), false);
  });

  await test("30アカウントを登録して一覧APIが順序付きで返す", async () => {
    for (let i = 1; i <= 30; i++) await createAccount(i);
    const { res, data } = await jsonFetch("/api/accounts");
    assert.equal(res.status, 200);
    assert(Array.isArray(data));
    assert.equal(data.length, 30);
    assert.equal((data[0] as { name: string }).name, "検証アカウント1");
  });

  await test("アカウント保存時は投稿時間帯の数を1日の投稿数へ同期する", async () => {
    await resetDb();
    const acc = await createAccount(1, {
      postingHours: "[6,12,18,21]",
      postsPerDay: 8,
    });
    const { res } = await jsonFetch("/api/accounts/update", {
      method: "PATCH",
      body: JSON.stringify({
        id: acc.id,
        name: acc.name,
        postingHours: "[9,13,21]",
        postsPerDay: 99,
      }),
    });
    assert.equal(res.status, 200);
    const updated = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    assert.equal(updated.postingHours, "[9,13,21]");
    assert.equal(updated.postsPerDay, 3);
  });

  await test("一括予約は既存予約/投稿から前後1時間以内を避ける", async () => {
    await resetDb();
    const acc = await createAccount(1, {
      postingHours: "[12,13,14,15]",
      scheduleJitterMinutes: 0,
    });
    const busyAt = buildJstSlots(new Date(), [12, 13, 14, 15], 1)[0];
    await prisma.post.create({
      data: {
        accountId: acc.id,
        groupNo: 900,
        body: "既存予約",
        postType: "standalone",
        charCount: 4,
        status: "queued",
        executor: "local",
        publishAt: busyAt,
      },
    });
    for (let i = 1; i <= 3; i++) await createDraft(acc.id, i);

    const { res, data } = await jsonFetch("/api/posts/bulk-queue", {
      method: "POST",
      body: JSON.stringify({ accountId: acc.id }),
    });
    assert.equal(res.status, 200);
    assertRecord(data);
    assert.equal(data.groups, 3);
    const queued = await prisma.post.findMany({
      where: { accountId: acc.id, status: "queued", groupNo: { in: [1, 2, 3] } },
      orderBy: { publishAt: "asc" },
    });
    assert.equal(queued.length, 3);
    const publishTimes = queued.map((p) => p.publishAt!.getTime());
    for (let i = 1; i < publishTimes.length; i++) {
      assert(publishTimes[i] - publishTimes[i - 1] >= 60 * 60 * 1000);
    }
    assert(
      queued.every((p) =>
        Math.abs(p.publishAt!.getTime() - busyAt.getTime()) >= 60 * 60 * 1000
      )
    );
  });

  await test("個別キュー追加は前後1時間以内の暴発予約を拒否する", async () => {
    await resetDb();
    const acc = await createAccount(1);
    const busyAt = futureDate(180);
    const blockedAt = new Date(busyAt.getTime() + 30 * 60 * 1000);
    const allowedAt = new Date(busyAt.getTime() + 60 * 60 * 1000);
    await prisma.post.create({
      data: {
        accountId: acc.id,
        groupNo: 1,
        body: "既存予約",
        postType: "standalone",
        charCount: 4,
        status: "queued",
        executor: "local",
        publishAt: busyAt,
      },
    });
    const draft = await createDraft(acc.id, 2);
    const blocked = await jsonFetch("/api/posts/group-action", {
      method: "POST",
      body: JSON.stringify({
        postId: draft.id,
        action: "queue",
        publishAt: blockedAt.toISOString(),
      }),
    });
    assert.equal(blocked.res.status, 409);
    assertRecord(blocked.data);
    assert.match(String(blocked.data.error), /前後1時間以内|1時間以上/);

    const allowed = await jsonFetch("/api/posts/group-action", {
      method: "POST",
      body: JSON.stringify({
        postId: draft.id,
        action: "queue",
        publishAt: allowedAt.toISOString(),
      }),
    });
    assert.equal(allowed.res.status, 200);
  });

  await test("過去時刻や直前すぎる予約はWeb側で拒否する", async () => {
    await resetDb();
    const acc = await createAccount(1);
    const draft = await createDraft(acc.id, 1);
    const blocked = await jsonFetch("/api/posts/group-action", {
      method: "POST",
      body: JSON.stringify({
        postId: draft.id,
        action: "queue",
        publishAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    });
    assert.equal(blocked.res.status, 400);
    assertRecord(blocked.data);
    assert.match(String(blocked.data.error), /過去の時刻|1分以上/);
    const unchanged = await prisma.post.findUnique({ where: { id: draft.id } });
    assert.equal(unchanged?.status, "draft");
  });

  await test("キュー済み投稿は未来時刻へ変更でき、DBへ反映される", async () => {
    await resetDb();
    const acc = await createAccount(1);
    const draft = await createDraft(acc.id, 1);
    const firstAt = futureDate(180);
    const queued = await jsonFetch("/api/posts/group-action", {
      method: "POST",
      body: JSON.stringify({
        postId: draft.id,
        action: "queue",
        publishAt: firstAt.toISOString(),
      }),
    });
    assert.equal(queued.res.status, 200);

    const nextAt = futureDate(300);
    const rescheduled = await jsonFetch("/api/posts/group-action", {
      method: "POST",
      body: JSON.stringify({
        postId: draft.id,
        action: "reschedule",
        publishAt: nextAt.toISOString(),
      }),
    });
    assert.equal(rescheduled.res.status, 200);
    const updated = await prisma.post.findUnique({ where: { id: draft.id } });
    assert.equal(updated?.status, "queued");
    assert.equal(updated?.publishAt?.toISOString(), nextAt.toISOString());
  });

  await test("失敗したツリーは投稿済み部分を触らず失敗分だけ再試行できる", async () => {
    await resetDb();
    const acc = await createAccount(1);
    const postedAt = new Date(Date.now() - 30 * 60 * 1000);
    await prisma.post.createMany({
      data: [
        {
          accountId: acc.id,
          groupNo: 5,
          sortOrder: 1,
          body: "投稿済みの親投稿",
          postType: "thread",
          charCount: 8,
          status: "posted",
          executor: "gas",
          threadsPostId: "18123456789000001",
          postedAt,
        },
        {
          accountId: acc.id,
          groupNo: 5,
          sortOrder: 2,
          body: "失敗した2投稿目",
          postType: "thread",
          charCount: 8,
          status: "error",
          executor: "gas",
          publishAt: futureDate(-10),
          error: "HTTP 400: The requested resource does not exist [OAuthException] (code:24)",
        },
        {
          accountId: acc.id,
          groupNo: 5,
          sortOrder: 3,
          body: "続きの3投稿目",
          postType: "thread",
          charCount: 8,
          status: "error",
          executor: "gas",
          publishAt: futureDate(-10),
          error: "前の投稿が失敗したため、続きの投稿を停止しました。",
        },
      ],
    });
    const failed = await prisma.post.findFirstOrThrow({
      where: { accountId: acc.id, groupNo: 5, sortOrder: 2 },
    });
    const { res, data } = await jsonFetch("/api/posts/group-action", {
      method: "POST",
      body: JSON.stringify({ postId: failed.id, action: "retryFailed" }),
    });
    assert.equal(res.status, 200);
    assertRecord(data);
    assert.equal(data.count, 2);

    const after = await prisma.post.findMany({
      where: { accountId: acc.id, groupNo: 5 },
      orderBy: { sortOrder: "asc" },
    });
    assert.equal(after[0].status, "posted");
    assert.equal(after[0].threadsPostId, "18123456789000001");
    assert.equal(after[0].postedAt?.toISOString(), postedAt.toISOString());
    assert.equal(after[1].status, "queued");
    assert.equal(after[2].status, "queued");
    assert.equal(after[1].executor, "local");
    assert.equal(after[2].executor, "local");
    assert.equal(after[1].error, null);
    assert.equal(after[2].error, null);
    assert(after[1].publishAt);
    assert(after[1].publishAt!.getTime() - postedAt.getTime() >= 60 * 60 * 1000);
    assert.equal(after[1].publishAt?.toISOString(), after[2].publishAt?.toISOString());
  });

  await test("失敗したツリーを下書きに戻しても投稿済み部分を触らない", async () => {
    await resetDb();
    const acc = await createAccount(1);
    const postedAt = futureDate(-90);
    await prisma.post.createMany({
      data: [
        {
          accountId: acc.id,
          groupNo: 6,
          sortOrder: 1,
          body: "投稿済みの親投稿",
          postType: "thread",
          charCount: 8,
          status: "posted",
          executor: "gas",
          threadsPostId: "18123456789000002",
          postedAt,
        },
        {
          accountId: acc.id,
          groupNo: 6,
          sortOrder: 2,
          body: "失敗した2投稿目",
          postType: "thread",
          charCount: 8,
          status: "error",
          executor: "gas",
          publishAt: futureDate(-10),
          error: "HTTP 400: The requested resource does not exist [OAuthException] (code:24)",
        },
        {
          accountId: acc.id,
          groupNo: 6,
          sortOrder: 3,
          body: "続きの3投稿目",
          postType: "thread",
          charCount: 8,
          status: "error",
          executor: "gas",
          publishAt: futureDate(-10),
          error: "前の投稿が失敗したため、続きの投稿を停止しました。",
        },
      ],
    });
    const failed = await prisma.post.findFirstOrThrow({
      where: { accountId: acc.id, groupNo: 6, sortOrder: 2 },
    });
    const { res, data } = await jsonFetch("/api/posts/group-action", {
      method: "POST",
      body: JSON.stringify({ postId: failed.id, action: "failedToDraft" }),
    });
    assert.equal(res.status, 200);
    assertRecord(data);
    assert.equal(data.count, 2);

    const after = await prisma.post.findMany({
      where: { accountId: acc.id, groupNo: 6 },
      orderBy: { sortOrder: "asc" },
    });
    assert.equal(after[0].status, "posted");
    assert.equal(after[0].threadsPostId, "18123456789000002");
    assert.equal(after[0].postedAt?.toISOString(), postedAt.toISOString());
    assert.equal(after[1].status, "draft");
    assert.equal(after[2].status, "draft");
    assert.equal(after[1].publishAt, null);
    assert.equal(after[2].publishAt, null);
    assert.equal(after[1].error, null);
    assert.equal(after[2].error, null);
  });

  await test("投稿済み一覧はスレッド内を親投稿から表示する", async () => {
    await resetDb();
    const acc = await createAccount(1);
    await prisma.post.createMany({
      data: [
        {
          accountId: acc.id,
          groupNo: 1,
          sortOrder: 1,
          body: "古いスレッド 親",
          postType: "thread",
          charCount: 8,
          status: "posted",
          postedAt: new Date("2026-05-15T01:00:00.000Z"),
        },
        {
          accountId: acc.id,
          groupNo: 1,
          sortOrder: 2,
          body: "古いスレッド 子",
          postType: "thread",
          charCount: 8,
          status: "posted",
          postedAt: new Date("2026-05-15T01:00:30.000Z"),
        },
        {
          accountId: acc.id,
          groupNo: 2,
          sortOrder: 3,
          body: "新しいスレッド 親",
          postType: "thread",
          charCount: 9,
          status: "posted",
          postedAt: new Date("2026-05-15T02:00:00.000Z"),
        },
        {
          accountId: acc.id,
          groupNo: 2,
          sortOrder: 4,
          body: "新しいスレッド 子",
          postType: "thread",
          charCount: 9,
          status: "posted",
          postedAt: new Date("2026-05-15T02:00:30.000Z"),
        },
      ],
    });

    const { res, data } = await jsonFetch(
      `/api/posts?accountId=${acc.id}&status=posted`
    );
    assert.equal(res.status, 200);
    assert(Array.isArray(data));
    assert.deepEqual(
      data.map((p: { body: string }) => p.body),
      [
        "新しいスレッド 親",
        "新しいスレッド 子",
        "古いスレッド 親",
        "古いスレッド 子",
      ]
    );
  });

  await test("自動投稿チェックは初心者向けに停止原因を返す", async () => {
    await resetDb();
    await createAccount(1, { accessToken: null });
    const { res, data } = await jsonFetch("/api/auto-posting/status");
    assert.equal(res.status, 200);
    assertRecord(data);
    assert.equal(data.level, "error");
    assert(Array.isArray(data.accounts));
    const first = data.accounts[0] as Record<string, unknown>;
    assert.match(String(first.title), /トークン/);
    assert.match(String(first.nextAction), /アクセストークン/);
  });

  await test("自動投稿チェックは直近エラーの投稿本文とエラー内容を返す", async () => {
    await resetDb();
    const acc = await createAccount(1);
    await prisma.post.create({
      data: {
        accountId: acc.id,
        groupNo: 7,
        sortOrder: 1,
        body: "失敗した投稿の本文です。エラー画面で原因が見える必要があります。",
        postType: "standalone",
        charCount: 32,
        status: "error",
        executor: "gas",
        publishAt: futureDate(-10),
        error: "Threads側で投稿に失敗しました。アクセストークンを確認してください。",
      },
    });

    const { res, data } = await jsonFetch("/api/auto-posting/status");
    assert.equal(res.status, 200);
    assertRecord(data);
    assert.equal(data.level, "error");
    const accounts = data.accounts as Record<string, unknown>[];
    assert.equal(accounts[0].error24h, 1);
    assert.match(String(accounts[0].nextAction), /エラー/);
    const recentErrors = accounts[0].recentErrors as Record<string, unknown>[];
    assert.equal(recentErrors.length, 1);
    assert.equal(recentErrors[0].groupNo, 7);
    assert.match(String(recentErrors[0].error), /アクセストークン/);
    assert.match(String(recentErrors[0].bodyPreview), /失敗した投稿/);

    const list = await jsonFetch(`/api/posts?accountId=${acc.id}&status=error`);
    assert.equal(list.res.status, 200);
    assert(Array.isArray(list.data));
    assert.equal(list.data.length, 1);
  });

  await test("30アカウントそれぞれが独立して安全なJST予約を持てる", async () => {
    await resetDb();
    for (let i = 1; i <= 30; i++) {
      const acc = await createAccount(i, {
        postingHours: "[6,12,18,21]",
        scheduleJitterMinutes: 0,
      });
      await createDraft(acc.id, 1);
      const { res } = await jsonFetch("/api/posts/bulk-queue", {
        method: "POST",
        body: JSON.stringify({ accountId: acc.id }),
      });
      assert.equal(res.status, 200);
    }
    const queued = await prisma.post.findMany({
      where: { status: "queued" },
      include: { account: true },
    });
    assert.equal(queued.length, 30);
    assert(queued.every((p) => p.executor === "local"));
    assert(queued.every((p) => toJstString(p.publishAt!).match(/T(06|12|18|21):00$/)));
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log(`\n✅ ${pass} final checks passed`);
  })
  .catch(async (e) => {
    await prisma.$disconnect();
    console.error(e);
    process.exit(1);
  });
