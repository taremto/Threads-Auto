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
