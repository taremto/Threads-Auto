/**
 * gas-sync.ts — クラウドオフロード結果の取り込みレイヤー
 *
 * 責務:
 *   - cloudOffloadEnabled なアカウントを巡回し pullResults → SQLite反映 → ackResults
 *   - Account.lastSyncedAt と tokenFingerprint, tokenExpiresAt を記録
 *
 * 呼び出し元: instrumentation.ts の cron（5分おき）, /api/cloud/sync (手動同期)
 */

import { prisma } from "@/lib/prisma";
import {
  ackResults,
  endpointFromAccount,
  pullResults,
  type PullResultRow,
} from "@/lib/gas-bridge";

let isRunning = false;

export type SyncAccountResult = {
  accountId: string;
  accountName: string;
  ok: boolean;
  fetched: number;
  applied: number;
  acked: number;
  tokenStatus?: "ok" | "expiring_soon" | "failed";
  tokenExpiresAt?: string | null;
  recentErrorCount24h?: number;
  error?: string;
};

export async function syncAllCloudAccounts(): Promise<SyncAccountResult[]> {
  if (isRunning) return [];
  isRunning = true;

  try {
    const accounts = await prisma.account.findMany({
      where: { cloudOffloadEnabled: true },
    });
    const out: SyncAccountResult[] = [];
    for (const acc of accounts) {
      out.push(await syncOneAccount(acc.id));
    }
    return out;
  } finally {
    isRunning = false;
  }
}

export async function syncOneAccount(accountId: string): Promise<SyncAccountResult> {
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc) {
    return {
      accountId,
      accountName: "?",
      ok: false,
      fetched: 0,
      applied: 0,
      acked: 0,
      error: "account not found",
    };
  }
  const ep = endpointFromAccount(acc);
  if (!ep) {
    return {
      accountId,
      accountName: acc.name,
      ok: false,
      fetched: 0,
      applied: 0,
      acked: 0,
      error: "GAS Web App URL/Key 未設定",
    };
  }

  // 保険: GAS から「エラー」通知が来ない（GAS側で status を切り替え忘れ、または通信断）ケースで
  // queued/executor='gas' のまま publishAt から長時間経過した投稿を error 化する。
  // pullResults 失敗時も走るよう、pullResults より前で実行する。
  await escalateStaleQueuedGasPosts(accountId);

  const r = await pullResults(ep);
  if (!r.ok || !r.data) {
    return {
      accountId,
      accountName: acc.name,
      ok: false,
      fetched: 0,
      applied: 0,
      acked: 0,
      error: r.error || "pullResults失敗",
    };
  }

  const fetched = r.data.count;
  let applied = 0;
  const ackable: string[] = [];

  for (const row of r.data.results) {
    const ok = await applyOne(row);
    if (ok) {
      applied++;
      ackable.push(row.webPostId);
    } else {
      // DBに該当レコードが無い等。ackしないことで再取得を許す
      console.warn(
        `[gas-sync] applyOne missed: webPostId=${row.webPostId} status=${row.status}`
      );
    }
  }

  // ack: 適用できた分だけ
  let acked = 0;
  if (ackable.length > 0) {
    const ar = await ackResults(ep, ackable);
    if (ar.ok && ar.data) acked = ar.data.acked;
  }

  // Account側の状態更新
  await prisma.account.update({
    where: { id: accountId },
    data: {
      lastSyncedAt: new Date(),
      tokenFingerprint: r.data.tokenFingerprint || null,
      tokenExpiresAt: r.data.tokenExpiresAt ? new Date(r.data.tokenExpiresAt) : null,
    },
  });

  return {
    accountId,
    accountName: acc.name,
    ok: true,
    fetched,
    applied,
    acked,
    tokenStatus: r.data.tokenStatus,
    tokenExpiresAt: r.data.tokenExpiresAt,
    recentErrorCount24h: r.data.recentErrorCount24h,
  };
}

/**
 * GAS から正規の「エラー」通知が届かないまま、publishAt から長時間（既定60分）経過した
 * queued/executor='gas' の投稿を error 化する保険。
 *
 * 背景: GAS の processScheduledPosts が「予約時刻を過ぎた」と判断したとき、過去には
 * スプシのメモ列にだけ理由を書き、status を「待機中」のまま放置していた。pullResults は
 * 「投稿済/エラー」しか返さないため、WebUI 側は永遠にその失敗を知らないままになっていた。
 *
 * GAS 側はその挙動を直したが、(1) ユーザーが GAS を未更新の状態、(2) GAS への通信断、
 * (3) 想定外の状態保留、にも備えるため WebUI 側でも多重防御として error 化する。
 */
async function escalateStaleQueuedGasPosts(
  accountId: string,
  maxDelayMs: number = 60 * 60 * 1000
): Promise<number> {
  const cutoff = new Date(Date.now() - maxDelayMs);
  const stale = await prisma.post.findMany({
    where: {
      accountId,
      status: "queued",
      executor: "gas",
      publishAt: { lt: cutoff },
    },
    select: { id: true },
  });
  if (stale.length === 0) return 0;
  await prisma.post.updateMany({
    where: { id: { in: stale.map((p) => p.id) } },
    data: {
      status: "error",
      error:
        "予約時刻を1時間以上過ぎても投稿確認が取れませんでした。「失敗分だけ再試行」または「時刻変更」で復旧してください。",
    },
  });
  console.warn(
    `[gas-sync] escalateStaleQueuedGasPosts: accountId=${accountId} escalated=${stale.length}`
  );
  return stale.length;
}

async function applyOne(row: PullResultRow): Promise<boolean> {
  // executor="gas" の Post を webPostId(=Post.id) で照合
  const existing = await prisma.post.findUnique({
    where: { id: row.webPostId },
  });
  if (!existing) return false;
  // 既にposted のものに上書きしない（冪等）
  if (existing.status === "posted") return true;

  if (row.status === "posted") {
    await prisma.post.update({
      where: { id: row.webPostId },
      data: {
        status: "posted",
        threadsPostId: row.threadsPostId,
        postUrl: row.postUrl,
        postedAt: row.postedAt ? new Date(row.postedAt) : new Date(),
        error: null,
      },
    });
    return true;
  }

  if (row.status === "error") {
    await prisma.post.update({
      where: { id: row.webPostId },
      data: {
        status: "error",
        error: row.error || "GAS側エラー",
      },
    });
    return true;
  }

  return false;
}
