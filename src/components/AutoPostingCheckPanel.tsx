"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

type AutoPostingStatus = {
  checkedAt: string;
  level: Level;
  title: string;
  message: string;
  totalAccounts: number;
  totalQueued: number;
  nextPostAt: string | null;
  accounts: AccountStatus[];
};

const levelStyle: Record<Level, {
  wrap: string;
  badge: string;
  label: string;
}> = {
  ok: {
    wrap: "border-emerald-200 bg-emerald-50",
    badge: "bg-emerald-600 text-white",
    label: "正常",
  },
  warning: {
    wrap: "border-amber-200 bg-amber-50",
    badge: "bg-amber-500 text-white",
    label: "確認",
  },
  error: {
    wrap: "border-red-200 bg-red-50",
    badge: "bg-red-600 text-white",
    label: "要対応",
  },
  off: {
    wrap: "border-gray-200 bg-gray-50",
    badge: "bg-gray-500 text-white",
    label: "準備中",
  },
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "なし";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "不明";
  return d.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFullDateTime(iso: string | null): string {
  if (!iso) return "なし";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "不明";
  return d.toLocaleString("ja-JP");
}

function buildSupportReport(status: AutoPostingStatus): string {
  const lines = [
    "【自動投稿チェック】",
    `チェック日時: ${formatFullDateTime(status.checkedAt)}`,
    `全体: ${levelStyle[status.level].label} / ${status.title}`,
    `予約中の投稿: ${status.totalQueued}件`,
    `次の投稿予定: ${formatDateTime(status.nextPostAt)}`,
    "",
    "【アカウント別】",
  ];

  for (const acc of status.accounts) {
    lines.push(
      `- ${acc.accountName}${acc.username ? ` (@${acc.username})` : ""}`,
      `  状態: ${levelStyle[acc.level].label} / ${acc.title}`,
      `  案内: ${acc.message}`,
      `  次にやること: ${acc.nextAction}`,
      `  予約: total=${acc.queuedTotal}, local=${acc.queuedLocal}, gas=${acc.queuedGas}, overdue=${acc.overdueQueued}`,
      `  直近24hエラー: ${acc.error24h}`,
      `  クラウド投稿: ${acc.cloudEnabled ? "ON" : "OFF"} / 接続情報=${acc.cloudReady ? "あり" : "なし"}`,
      `  最終同期: ${formatFullDateTime(acc.lastSyncedAt)}`,
      `  トークン期限: ${formatFullDateTime(acc.tokenExpiresAt)}`,
      `  GAS: ok=${acc.gas.ok}, configured=${acc.gas.configured}, hasTrigger=${acc.gas.hasTrigger}, hasTokenRefreshTrigger=${acc.gas.hasTokenRefreshTrigger}, tokenStatus=${acc.gas.tokenStatus || "不明"}, scriptTimeZone=${acc.gas.scriptTimeZone || "不明"}, spreadsheetTimeZone=${acc.gas.spreadsheetTimeZone || "不明"}, version=${acc.gas.version || "不明"}`,
      `  GASエラー: ${acc.gas.error || "なし"}`,
      `  トークン更新エラー: ${acc.gas.tokenLastError || "なし"}`,
      `  秘密情報: accessToken=${acc.support.hasAccessToken ? "保存あり" : "なし"}, gasUrl=${acc.support.hasGasUrl ? "保存あり" : "なし"}, gasKey=${acc.support.hasGasKey ? "保存あり" : "なし"}, tokenFingerprint=${acc.support.tokenFingerprint || "なし"}`,
      ""
    );
  }

  return lines.join("\n");
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 権限が拒否されたブラウザでは、下のtextarea方式にフォールバックする。
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

export default function AutoPostingCheckPanel() {
  const [status, setStatus] = useState<AutoPostingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auto-posting/status", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "自動投稿チェックに失敗しました");
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(fetchStatus);
    const id = window.setInterval(fetchStatus, 30000);
    return () => window.clearInterval(id);
  }, [fetchStatus]);

  const report = useMemo(() => (status ? buildSupportReport(status) : ""), [status]);

  async function handleCopyReport() {
    if (!report) return;
    await copyText(report);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  const level = status?.level ?? "off";
  const style = levelStyle[level];

  return (
    <section className={`mb-4 rounded-xl border p-4 ${style.wrap}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs font-bold ${style.badge}`}>
              {style.label}
            </span>
            <h3 className="text-base font-bold text-gray-800">自動投稿チェック</h3>
          </div>
          <p className="mt-2 text-sm font-semibold text-gray-800">
            {status?.title || "自動投稿の状態を確認しています"}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-gray-600">
            {status?.message ||
              "予約投稿、Google側の自動実行、トークン期限をまとめて確認します。"}
          </p>
        </div>
        <button
          type="button"
          onClick={fetchStatus}
          disabled={loading}
          className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? "確認中" : "再チェック"}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs text-red-600">
          {error}
        </div>
      )}

      {status && (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <StatusMetric label="予約中" value={`${status.totalQueued}件`} />
            <StatusMetric label="次の投稿" value={formatDateTime(status.nextPostAt)} />
            <StatusMetric label="最終確認" value={formatDateTime(status.checkedAt)} />
          </div>

          <div className="mt-4 space-y-2">
            {status.accounts.map((acc) => (
              <AccountCheckRow key={acc.accountId} account={acc} />
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopyReport}
              className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
            >
              {copied ? "コピーしました" : "サポート用レポートをコピー"}
            </button>
            <span className="text-[11px] text-gray-500">
              トークンや認証キーの中身は出しません。Discordサポートにそのまま貼れます。
            </span>
          </div>
        </>
      )}
    </section>
  );
}

function StatusMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/70 bg-white/80 px-3 py-2">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className="mt-0.5 truncate text-sm font-bold text-gray-800">{value}</div>
    </div>
  );
}

function AccountCheckRow({ account }: { account: AccountStatus }) {
  const style = levelStyle[account.level];
  return (
    <details className="rounded-lg border border-white/70 bg-white/90 px-3 py-2">
      <summary className="cursor-pointer list-none">
        <div className="flex items-start gap-2">
          <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${style.badge}`}>
            {style.label}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-bold text-gray-800">{account.accountName}</span>
              {account.username && (
                <span className="text-xs text-gray-400">@{account.username}</span>
              )}
            </div>
            <div className="mt-1 text-sm font-semibold text-gray-700">
              {account.title}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-gray-500">
              {account.nextAction}
            </div>
          </div>
          <div className="hidden text-right text-[11px] text-gray-400 sm:block">
            <div>予約 {account.queuedTotal}件</div>
            <div>次 {formatDateTime(account.nextPostAt)}</div>
          </div>
        </div>
      </summary>

      <div className="mt-3 grid gap-2 text-xs text-gray-600 sm:grid-cols-2">
        <Detail label="予約中" value={`${account.queuedTotal}件`} />
        <Detail label="次の投稿" value={formatDateTime(account.nextPostAt)} />
        <Detail label="PC投稿" value={`${account.queuedLocal}件`} />
        <Detail label="クラウド投稿" value={`${account.queuedGas}件`} />
        <Detail label="最終同期" value={formatFullDateTime(account.lastSyncedAt)} />
        <Detail label="直近24hエラー" value={`${account.error24h}件`} />
        <Detail label="Google接続" value={account.gas.ok ? "接続OK" : account.gas.error || "未接続"} />
        <Detail label="Google自動実行" value={account.gas.hasTrigger === null ? "不明" : account.gas.hasTrigger ? "あり" : "なし"} />
        <Detail label="トークン自動更新" value={account.gas.hasTokenRefreshTrigger === null ? "不明" : account.gas.hasTokenRefreshTrigger ? "あり" : "なし"} />
        <Detail label="トークン状態" value={account.gas.tokenStatus === "failed" ? "更新失敗" : account.gas.tokenStatus === "expiring_soon" ? "期限が近い" : account.gas.tokenStatus === "ok" ? "正常" : "不明"} />
        <Detail label="タイムゾーン" value={account.gas.scriptTimeZone || "不明"} />
        <Detail label="トークン期限" value={formatFullDateTime(account.tokenExpiresAt)} />
        {account.gas.tokenLastError && (
          <Detail label="トークン更新エラー" value={account.gas.tokenLastError} />
        )}
      </div>
    </details>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5">
      <span className="text-gray-400">{label}: </span>
      <span className="break-words text-gray-700">{value}</span>
    </div>
  );
}
