import { prisma } from "@/lib/prisma";
import { endpointFromAccount, healthCheck } from "@/lib/gas-bridge";
import { NextResponse } from "next/server";

type Level = "ok" | "warning" | "error" | "off";

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
  lastSyncedAt: string | null;
  tokenExpiresAt: string | null;
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
    error: string | null;
  };
  support: {
    hasAccessToken: boolean;
    hasGasUrl: boolean;
    hasGasKey: boolean;
    tokenFingerprint: string | null;
  };
};

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
  nextPostAt?: string | null;
}, gas: AccountStatus["gas"]): Pick<AccountStatus, "level" | "title" | "message" | "nextAction"> {
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
      nextAction: "投稿一覧のエラー表示を確認し、必要ならアクセストークンを更新してください。",
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

  if (counts.overdueQueued > 0) {
    return {
      level: "warning",
      title: "予定時刻を過ぎた投稿があります",
      message: "投稿処理が止まっている、または結果同期が遅れている可能性があります。",
      nextAction: "自動投稿チェックを再実行し、改善しなければサポート用レポートを送ってください。",
    };
  }

  const hasEndpoint = !!account.gasWebAppUrl && !!account.gasWebAppKey;
  if (account.cloudOffloadEnabled) {
    if (!hasEndpoint) {
      return {
        level: "error",
        title: "クラウド投稿の設定が壊れています",
        message: "クラウド投稿はONですが、Google側の接続情報が見つかりません。",
        nextAction: "クラウドオフロードを再設定してください。",
      };
    }
    if (!gas.ok) {
      return {
        level: "error",
        title: "Google側に接続できません",
        message: "PCを閉じても投稿するためのGoogle連携に接続できませんでした。",
        nextAction: "ネット接続とGAS URLを確認し、サポート用レポートを送ってください。",
      };
    }
    if (!gas.configured) {
      return {
        level: "error",
        title: "Google側の初期設定が未完了です",
        message: "Google側に投稿用トークンが入っていません。",
        nextAction: "クラウドオフロードを再設定してください。",
      };
    }
    if (gas.tokenStatus === "failed" || gas.tokenLastError) {
      return {
        level: "error",
        title: "アクセストークンの自動更新に失敗しています",
        message: "Google側で投稿に使う許可情報を更新できませんでした。",
        nextAction: "アクセストークンを取り直して、クラウドオフロードを再設定してください。",
      };
    }
    if (gas.scriptTimeZone && gas.scriptTimeZone !== "Asia/Tokyo") {
      return {
        level: "error",
        title: "Google側のタイムゾーンが違います",
        message: "予約時刻と実際の投稿時刻がずれる可能性があります。",
        nextAction: "GASプロジェクトのタイムゾーンをAsia/Tokyoに直して再設定してください。",
      };
    }
    if (!gas.hasTrigger) {
      return {
        level: "error",
        title: "Google側の自動実行が止まっています",
        message: "予約時刻になっても投稿されない可能性があります。",
        nextAction: "クラウドオフロードを再設定してください。",
      };
    }
    if (!gas.hasTokenRefreshTrigger) {
      return {
        level: "warning",
        title: "トークン自動更新の予約が見つかりません",
        message: "今すぐ投稿はできても、長期間放置すると投稿許可の期限が切れる可能性があります。",
        nextAction: "クラウドオフロードを再設定してください。",
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
          nextQueued,
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
          prisma.post.findFirst({
            where: {
              accountId: account.id,
              status: "queued",
              publishAt: { not: null },
            },
            orderBy: { publishAt: "asc" },
            select: { publishAt: true },
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
          nextPostAt: nextQueued?.publishAt?.toISOString() ?? null,
        };
        const summary = summarize(account, counts, gas);

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
          lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
          tokenExpiresAt: gas.tokenExpiresAt ?? account.tokenExpiresAt?.toISOString() ?? null,
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
