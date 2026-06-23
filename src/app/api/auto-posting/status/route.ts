import { prisma } from "@/lib/prisma";
import {
  endpointFromAccount,
  gasVersionUpgradeMessage,
  healthCheck,
  isGasVersionSupported,
} from "@/lib/gas-bridge";
import { NextResponse } from "next/server";

type Level = "ok" | "warning" | "error" | "off";

type RecentErrorPost = {
  id: string;
  groupNo: number;
  bodyPreview: string;
  error: string | null;
  executor: string;
  publishAt: string | null;
  updatedAt: string;
};

type AccountStatus = {
  accountId: string;
  accountName: string;
  username: string | null;
  level: Level;
  title: string;
  message: string;
  nextAction: string;
  cloudEnabled: boolean;
  cloudReady: boolean;
  nextPostAt: string | null;
  queuedTotal: number;
  queuedLocal: number;
  queuedGas: number;
  overdueQueued: number;
  error24h: number;
  lastPostedAt: string | null;
  safetyHoldUntil: string | null;
  lastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  recentErrors: RecentErrorPost[];
  gas: {
    ok: boolean;
    configured: boolean | null;
    hasTrigger: boolean | null;
    hasTokenRefreshTrigger: boolean | null;
    tokenStatus: "ok" | "expiring_soon" | "failed" | null;
    tokenExpiresAt: string | null;
    tokenLastError: string | null;
    scriptTimeZone: string | null;
    spreadsheetTimeZone: string | null;
    version: string | null;
    triggerResetAt: string | null;
    lastProcessAttemptAt: string | null;
    lastProcessFinishAt: string | null;
    lastProcessSkippedAt: string | null;
    lastProcessSummary: string | null;
    lastProcessErrorAt: string | null;
    lastProcessError: string | null;
    error: string | null;
  };
  support: {
    hasAccessToken: boolean;
    hasGasUrl: boolean;
    hasGasKey: boolean;
    tokenFingerprint: string | null;
  };
};

function bodyPreview(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= 80) return compact;
  return `${compact.slice(0, 80)}...`;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - Date.now()) / (24 * 60 * 60 * 1000));
}

function recentEnough(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < 30 * 60 * 1000;
}

function summarize(account: {
  accessToken: string | null;
  cloudOffloadEnabled: boolean;
  gasWebAppUrl: string | null;
  gasWebAppKey: string | null;
  lastSyncedAt: Date | null;
  tokenExpiresAt: Date | null;
}, counts: {
  queuedTotal: number;
  queuedLocal: number;
  queuedGas: number;
  overdueQueued: number;
  error24h: number;
  lastPostedAt?: string | null;
  nextPostAt?: string | null;
}, gas: AccountStatus["gas"], opts: {
  duplicateGasUrl: boolean;
}): Pick<AccountStatus, "level" | "title" | "message" | "nextAction"> {
  if (!account.accessToken) {
    return {
      level: "error",
      title: "投稿に必要なトークンが未設定です",
      message: "このアカウントは、予約してもThreadsへ投稿できません。",
      nextAction: "アカウント編集からアクセストークンを保存してください。",
    };
  }

  if (counts.error24h > 0) {
    return {
      level: "error",
      title: "直近24時間に投稿エラーがあります",
      message: "一部の予約投稿が失敗しています。エラー内容を確認してください。",
      nextAction: "左メニューの「エラー」を開いて内容を確認し、必要ならアクセストークンを更新してください。",
    };
  }

  if (opts.duplicateGasUrl) {
    return {
      level: "error",
      title: "クラウド投稿の設定が他アカウントと重複しています",
      message: "同じGoogle連携を複数アカウントで使うと、別アカウントのトークンで投稿されるおそれがあります。",
      nextAction: "誤投稿を防ぐため、このアカウントで「Google投稿を修復する」を押してください。アプリが別のGoogle連携を保存し直します。",
    };
  }

  const tokenExpiresAt = gas.tokenExpiresAt ?? account.tokenExpiresAt?.toISOString() ?? null;
  const tokenDays = daysUntil(tokenExpiresAt);
  if (tokenDays !== null && tokenDays < 0) {
    return {
      level: "error",
      title: "アクセストークンの期限が切れています",
      message: "このままだと自動投稿できません。",
      nextAction: "アクセストークンを更新して、クラウド設定を再同期してください。",
    };
  }
  if (tokenDays !== null && tokenDays < 7) {
    return {
      level: "warning",
      title: "アクセストークンの期限が近いです",
      message: `残り${Math.max(tokenDays, 0)}日です。早めの更新をおすすめします。`,
      nextAction: "アクセストークンを更新できる状態か確認してください。",
    };
  }

  const hasEndpoint = !!account.gasWebAppUrl && !!account.gasWebAppKey;
  if (account.cloudOffloadEnabled) {
    if (!hasEndpoint) {
      return {
        level: "error",
        title: "クラウド投稿の設定が壊れています",
        message: "クラウド投稿はONですが、Google側の接続情報が見つかりません。",
        nextAction: "設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。",
      };
    }
    if (!gas.ok) {
      return {
        level: "error",
        title: "Google側に接続できません",
        message: "PCを閉じても投稿するためのGoogle連携に接続できませんでした。",
        nextAction: "設定のクラウドオフロード欄、またはこの画面の「Google投稿を修復する」を押してください。直らなければサポート用レポートを送ってください。",
      };
    }
    if (!isGasVersionSupported(gas.version)) {
      return {
        level: "error",
        title: "Google側のコードが古いです",
        message: "アプリ本体とは別に、Google側の投稿コードも更新する必要があります。",
        nextAction: gasVersionUpgradeMessage(gas.version),
      };
    }
    if (!gas.configured) {
      return {
        level: "error",
        title: "Google側の初期設定が未完了です",
        message: "Google側に投稿用トークンが入っていません。",
        nextAction: "設定のクラウドオフロード欄、またはこの画面の「Google投稿を修復する」を押してください。",
      };
    }
    if (gas.tokenStatus === "failed" || gas.tokenLastError) {
      return {
        level: "error",
        title: "アクセストークンの自動更新に失敗しています",
        message: "Google側で投稿に使う許可情報を更新できませんでした。",
        nextAction: "アクセストークンを取り直して保存し、その後「Google投稿を修復する」を押してください。",
      };
    }
    if (gas.scriptTimeZone && gas.scriptTimeZone !== "Asia/Tokyo") {
      return {
        level: "error",
        title: "Google側のタイムゾーンが違います",
        message: "予約時刻と実際の投稿時刻がずれる可能性があります。",
        nextAction: "「Google投稿を修復する」を押してください。アプリがGoogle側のタイムゾーンを確認します。",
      };
    }
    if (!gas.hasTrigger) {
      return {
        level: "error",
        title: "Google側の自動実行が止まっています",
        message: "予約時刻になっても投稿されない可能性があります。",
        nextAction: "「Google投稿を修復する」を押してください。アプリが自動実行を作り直します。",
      };
    }
    if (gas.lastProcessError) {
      return {
        level: "error",
        title: "Google側の自動実行でエラーが出ています",
        message: gas.lastProcessError,
        nextAction: "「Google投稿を修復する」を押してください。直らなければサポート用レポートを送ってください。",
      };
    }
    if (counts.queuedGas > 0 && counts.nextPostAt) {
      const nextMs = new Date(counts.nextPostAt).getTime();
      const attemptMs = gas.lastProcessAttemptAt
        ? new Date(gas.lastProcessAttemptAt).getTime()
        : NaN;
      if (
        Number.isFinite(nextMs) &&
        Date.now() - nextMs > 3 * 60 * 1000 &&
        (!Number.isFinite(attemptMs) || attemptMs < nextMs)
      ) {
        return {
          level: "error",
          title: "Google側の自動実行が動いていません",
          message: "予約時刻を過ぎていますが、Google側の投稿処理が起動した記録がありません。",
          nextAction: "「Google投稿を修復する」を押してください。アプリが自動実行を作り直します。",
        };
      }
    }
    if (counts.overdueQueued > 0) {
      const lastPostedMs = counts.lastPostedAt ? new Date(counts.lastPostedAt).getTime() : NaN;
      const safetyHoldMs = Number.isFinite(lastPostedMs)
        ? lastPostedMs + 60 * 60 * 1000
        : NaN;
      if (Number.isFinite(safetyHoldMs) && Date.now() < safetyHoldMs) {
        return {
          level: "ok",
          title: "安全間隔のため待機中です",
          message: "直近投稿から1時間以上空けるため、予定時刻を過ぎた投稿をGoogle側で待機させています。",
          nextAction: "1時間の安全間隔を過ぎると、Google側が1予約ずつ自動で投稿します。",
        };
      }
      return {
        level: "warning",
        title: "予定時刻を過ぎた投稿があります",
        message: "Google側の投稿処理またはWeb画面への結果反映が遅れている可能性があります。",
        nextAction: "設定画面の「今すぐ同期」を押してください。改善しなければサポート用レポートを送ってください。",
      };
    }
    if (!gas.hasTokenRefreshTrigger) {
      return {
        level: "warning",
      title: "トークン自動更新の予約が見つかりません",
      message: "今すぐ投稿はできても、長期間放置すると投稿許可の期限が切れる可能性があります。",
      nextAction: "「Google投稿を修復する」を押してください。アプリが自動更新の予約を作り直します。",
      };
    }
    if (counts.queuedGas > 0 && !recentEnough(account.lastSyncedAt?.toISOString() ?? null)) {
      return {
        level: "warning",
        title: "最近の同期が確認できません",
        message: "投稿自体はGoogle側で動く可能性がありますが、Web画面への反映が遅れるかもしれません。",
        nextAction: "設定画面の「今すぐ同期」を押してください。",
      };
    }
    if (counts.queuedGas > 0 || counts.nextPostAt) {
      return {
        level: "ok",
        title: "自動投稿は動作できる状態です",
        message: "PCを閉じていても、予約時刻になればGoogle側から投稿されます。",
        nextAction: "このまま放置して大丈夫です。",
      };
    }
    return {
      level: "ok",
      title: "クラウド投稿は正常です",
      message: "今は予約中の投稿がありません。",
      nextAction: "下書きを作って予約投稿に入れると、自動投稿が始まります。",
    };
  }

  if (counts.queuedLocal > 0) {
    return {
      level: "warning",
      title: "PCを閉じると予約投稿が止まります",
      message: "予約投稿がありますが、クラウド投稿がOFFです。",
      nextAction: "放置運用したい場合はクラウドオフロードを有効にしてください。",
    };
  }

  return {
    level: hasEndpoint ? "off" : "off",
    title: "自動投稿の予約はありません",
    message: hasEndpoint
      ? "クラウド投稿は準備済みですが、現在はOFFです。"
      : "PCを閉じても投稿したい場合は、クラウドオフロードを設定してください。",
    nextAction: "下書きを作って予約するか、クラウドオフロードを設定してください。",
  };
}

function overallLevel(items: AccountStatus[]): Level {
  if (items.some((i) => i.level === "error")) return "error";
  if (items.some((i) => i.level === "warning")) return "warning";
  if (items.some((i) => i.level === "ok")) return "ok";
  return "off";
}

function overallMessage(level: Level, totalQueued: number): string {
  if (level === "error") return "自動投稿に止まる原因があります。赤い項目を確認してください。";
  if (level === "warning") return "自動投稿に確認した方がいい項目があります。";
  if (level === "ok") return totalQueued > 0 ? "予約投稿は放置で動作できる状態です。" : "自動投稿の仕組みは正常です。";
  return "まだ予約投稿がない、またはクラウド投稿が未設定です。";
}

export async function GET() {
  try {
    const accounts = await prisma.account.findMany({
      orderBy: { createdAt: "asc" },
    });
    const gasUrlCounts = new Map<string, number>();
    for (const account of accounts) {
      if (!account.gasWebAppUrl) continue;
      gasUrlCounts.set(
        account.gasWebAppUrl,
        (gasUrlCounts.get(account.gasWebAppUrl) ?? 0) + 1
      );
    }
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const overdueBefore = new Date(now.getTime() - 5 * 60 * 1000);

    const items: AccountStatus[] = await Promise.all(
      accounts.map(async (account) => {
        const [
          queuedTotal,
          queuedLocal,
          queuedGas,
          overdueQueued,
          error24h,
          recentErrors,
          nextQueued,
          lastPosted,
        ] = await Promise.all([
          prisma.post.count({ where: { accountId: account.id, status: "queued" } }),
          prisma.post.count({ where: { accountId: account.id, status: "queued", executor: "local" } }),
          prisma.post.count({ where: { accountId: account.id, status: "queued", executor: "gas" } }),
          prisma.post.count({
            where: {
              accountId: account.id,
              status: "queued",
              publishAt: { lt: overdueBefore },
            },
          }),
          prisma.post.count({
            where: {
              accountId: account.id,
              status: "error",
              updatedAt: { gte: oneDayAgo },
            },
          }),
          prisma.post.findMany({
            where: {
              accountId: account.id,
              status: "error",
              updatedAt: { gte: oneDayAgo },
            },
            orderBy: { updatedAt: "desc" },
            take: 3,
            select: {
              id: true,
              groupNo: true,
              body: true,
              error: true,
              executor: true,
              publishAt: true,
              updatedAt: true,
            },
          }),
          prisma.post.findFirst({
            where: {
              accountId: account.id,
              status: "queued",
              publishAt: { not: null },
            },
            orderBy: { publishAt: "asc" },
            select: { publishAt: true },
          }),
          prisma.post.findFirst({
            where: {
              accountId: account.id,
              status: "posted",
              postedAt: { not: null },
            },
            orderBy: { postedAt: "desc" },
            select: { postedAt: true },
          }),
        ]);

        let gas: AccountStatus["gas"] = {
          ok: false,
          configured: null,
          hasTrigger: null,
          hasTokenRefreshTrigger: null,
          tokenStatus: null,
          tokenExpiresAt: null,
          tokenLastError: null,
          scriptTimeZone: null,
          spreadsheetTimeZone: null,
          version: null,
          triggerResetAt: null,
          lastProcessAttemptAt: null,
          lastProcessFinishAt: null,
          lastProcessSkippedAt: null,
          lastProcessSummary: null,
          lastProcessErrorAt: null,
          lastProcessError: null,
          error: null,
        };
        const endpoint = endpointFromAccount(account);
        if (endpoint) {
          const health = await healthCheck(endpoint);
          if (health.ok && health.data) {
            gas = {
              ok: true,
              configured: health.data.configured,
              hasTrigger: health.data.hasTrigger,
              hasTokenRefreshTrigger: health.data.hasTokenRefreshTrigger ?? null,
              tokenStatus: health.data.tokenStatus ?? null,
              tokenExpiresAt: health.data.tokenExpiresAt ?? null,
              tokenLastError: health.data.tokenLastError ?? null,
              scriptTimeZone: health.data.scriptTimeZone ?? null,
              spreadsheetTimeZone: health.data.spreadsheetTimeZone ?? null,
              version: health.data.version ?? null,
              triggerResetAt: health.data.triggerResetAt ?? null,
              lastProcessAttemptAt: health.data.lastProcessAttemptAt ?? null,
              lastProcessFinishAt: health.data.lastProcessFinishAt ?? null,
              lastProcessSkippedAt: health.data.lastProcessSkippedAt ?? null,
              lastProcessSummary: health.data.lastProcessSummary ?? null,
              lastProcessErrorAt: health.data.lastProcessErrorAt ?? null,
              lastProcessError: health.data.lastProcessError ?? null,
              error: null,
            };
          } else {
            gas = {
              ...gas,
              error: health.error || `HTTP ${health.httpStatus || "unknown"}`,
            };
          }
        }

        const counts = {
          queuedTotal,
          queuedLocal,
          queuedGas,
          overdueQueued,
          error24h,
          lastPostedAt: lastPosted?.postedAt?.toISOString() ?? null,
          nextPostAt: nextQueued?.publishAt?.toISOString() ?? null,
        };
        const lastPostedMs = counts.lastPostedAt
          ? new Date(counts.lastPostedAt).getTime()
          : NaN;
        const safetyHoldUntil =
          Number.isFinite(lastPostedMs) &&
          counts.overdueQueued > 0 &&
          counts.queuedGas > 0
            ? new Date(lastPostedMs + 60 * 60 * 1000).toISOString()
            : null;
        const summary = summarize(account, counts, gas, {
          duplicateGasUrl:
            !!account.gasWebAppUrl &&
            (gasUrlCounts.get(account.gasWebAppUrl) ?? 0) > 1,
        });

        return {
          accountId: account.id,
          accountName: account.name,
          username: account.threadsUsername,
          ...summary,
          cloudEnabled: account.cloudOffloadEnabled,
          cloudReady: !!endpoint,
          nextPostAt: counts.nextPostAt,
          queuedTotal,
          queuedLocal,
          queuedGas,
          overdueQueued,
          error24h,
          lastPostedAt: counts.lastPostedAt,
          safetyHoldUntil,
          lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
          tokenExpiresAt: gas.tokenExpiresAt ?? account.tokenExpiresAt?.toISOString() ?? null,
          recentErrors: recentErrors.map((post) => ({
            id: post.id,
            groupNo: post.groupNo,
            bodyPreview: bodyPreview(post.body),
            error: post.error || null,
            executor: post.executor,
            publishAt: post.publishAt?.toISOString() ?? null,
            updatedAt: post.updatedAt.toISOString(),
          })),
          gas,
          support: {
            hasAccessToken: !!account.accessToken,
            hasGasUrl: !!account.gasWebAppUrl,
            hasGasKey: !!account.gasWebAppKey,
            tokenFingerprint: account.tokenFingerprint,
          },
        };
      })
    );

    const level = overallLevel(items);
    const totalQueued = items.reduce((sum, i) => sum + i.queuedTotal, 0);
    return NextResponse.json({
      checkedAt: now.toISOString(),
      level,
      title:
        level === "ok"
          ? "自動投稿は正常に動作できる状態です"
          : level === "error"
            ? "自動投稿に修正が必要です"
            : level === "warning"
              ? "自動投稿に確認が必要です"
              : "自動投稿はまだ準備中です",
      message: overallMessage(level, totalQueued),
      totalAccounts: items.length,
      totalQueued,
      nextPostAt:
        items
          .map((i) => i.nextPostAt)
          .filter((v): v is string => !!v)
          .sort()[0] ?? null,
      accounts: items,
    });
  } catch (e) {
    console.error("[/api/auto-posting/status] error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
