"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

type AppVersion = {
  version: string;
  releaseDate: string | null;
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

function buildSupportReport(status: AutoPostingStatus, appVersion: AppVersion | null): string {
  const lines = [
    "【自動投稿チェック】",
    `現在のバージョン: ${appVersion?.version || "不明"}`,
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
      `  直近エラー詳細: ${
        acc.recentErrors.length > 0
          ? acc.recentErrors
              .map((post) =>
                `#${post.groupNo} ${formatFullDateTime(post.updatedAt)} ${post.error || "エラー内容なし"}`
              )
              .join(" / ")
          : "なし"
      }`,
      `  直近投稿: ${formatFullDateTime(acc.lastPostedAt)}`,
      `  安全待機終了: ${formatFullDateTime(acc.safetyHoldUntil)}`,
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
  const [appVersion, setAppVersion] = useState<AppVersion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [upgradingAccountId, setUpgradingAccountId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

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

  const fetchAppVersion = useCallback(async () => {
    try {
      const res = await fetch("/api/app-version", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setAppVersion(data);
    } catch {
      setAppVersion(null);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(fetchAppVersion);
    queueMicrotask(fetchStatus);
    const id = window.setInterval(fetchStatus, 30000);
    return () => window.clearInterval(id);
  }, [fetchStatus, fetchAppVersion]);

  const report = useMemo(
    () => (status ? buildSupportReport(status, appVersion) : ""),
    [status, appVersion]
  );

  async function handleCopyReport() {
    if (!report) return;
    await copyText(report);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  async function handleUpgradeGasCode(accountId: string) {
    setUpgradingAccountId(accountId);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/cloud/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repairCloudPosting", accountId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Google投稿の修復に失敗しました");
      }
      setNotice(data.message || "Google投稿を修復しました。");
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpgradingAccountId(null);
    }
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
          {loading ? "確認中" : "状態を確認"}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs text-red-600">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-3 rounded-lg border border-sky-200 bg-white px-3 py-2 text-xs text-sky-700">
          {notice}
        </div>
      )}

      {status && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <StatusMetric label="現在のバージョン" value={appVersion?.version || "確認中"} />
            <StatusMetric label="予約中" value={`${status.totalQueued}件`} />
            <StatusMetric label="次の投稿" value={formatDateTime(status.nextPostAt)} />
            <StatusMetric label="最終確認" value={formatDateTime(status.checkedAt)} />
          </div>

          <div className="mt-4 space-y-2">
            {status.accounts.map((acc) => (
              <AccountCheckRow
                key={acc.accountId}
                account={acc}
                onUpgradeGasCode={handleUpgradeGasCode}
                upgrading={upgradingAccountId === acc.accountId}
              />
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
      <div className="mt-0.5 break-words text-sm font-bold leading-snug text-gray-800">
        {value}
      </div>
    </div>
  );
}

function AccountCheckRow({
  account,
  onUpgradeGasCode,
  upgrading,
}: {
  account: AccountStatus;
  onUpgradeGasCode: (accountId: string) => void;
  upgrading: boolean;
}) {
  const style = levelStyle[account.level];
  const needsCloudRepair = account.nextAction.includes("Google投稿を修復");
  const hasRecentErrors = account.error24h > 0;
  const wrapClass = hasRecentErrors
    ? "border-red-200 bg-red-50/80"
    : "border-white/70 bg-white/90";
  return (
    <details className={`rounded-lg border px-3 py-2 ${wrapClass}`}>
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
            <div className={`mt-1 text-sm font-semibold ${hasRecentErrors ? "text-red-800" : "text-gray-700"}`}>
              {account.title}
            </div>
            <div className={`mt-0.5 text-xs leading-relaxed ${hasRecentErrors ? "text-red-700" : "text-gray-500"}`}>
              {account.message}
            </div>
            <div className={`mt-0.5 text-xs leading-relaxed ${hasRecentErrors ? "text-red-700" : "text-gray-500"}`}>
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
        {hasRecentErrors && <RecentErrorGuide account={account} />}
        {needsCloudRepair && (
          <div className="sm:col-span-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-800">
            <div className="font-bold">このボタンでGoogle投稿を修復できます</div>
            <div className="mt-1 text-red-700">
              Google側のコード、自動実行、タイムゾーン、投稿用トークン、予約キューをまとめて確認します。
              修復が終わったら自動で状態を確認します。
            </div>
            <button
              type="button"
              disabled={upgrading}
              onClick={() => onUpgradeGasCode(account.accountId)}
              className="mt-2 rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {upgrading ? "修復中..." : "このアカウントのGoogle投稿を修復"}
            </button>
          </div>
        )}
        <Detail label="予約中" value={`${account.queuedTotal}件`} />
        <Detail label="次の投稿" value={formatDateTime(account.nextPostAt)} />
        <Detail label="PC投稿" value={`${account.queuedLocal}件`} />
        <Detail label="クラウド投稿" value={`${account.queuedGas}件`} />
        <Detail label="最終同期" value={formatFullDateTime(account.lastSyncedAt)} />
        <Detail label="直近投稿" value={formatFullDateTime(account.lastPostedAt)} />
        {account.safetyHoldUntil && (
          <Detail label="安全待機終了" value={formatFullDateTime(account.safetyHoldUntil)} />
        )}
        <Detail
          label="直近24hエラー"
          value={`${account.error24h}件`}
          tone={account.error24h > 0 ? "error" : "neutral"}
        />
        <Detail
          label="Google接続"
          value={account.gas.ok ? "接続OK" : account.gas.error || "未接続"}
          tone={account.gas.ok ? "neutral" : "error"}
        />
        <Detail
          label="Google自動実行"
          value={account.gas.hasTrigger === null ? "不明" : account.gas.hasTrigger ? "あり" : "なし"}
          tone={account.gas.hasTrigger === false ? "error" : "neutral"}
        />
        <Detail label="Google実行記録" value={formatFullDateTime(account.gas.lastProcessAttemptAt)} />
        {account.gas.lastProcessSummary && (
          <Detail label="Google実行結果" value={account.gas.lastProcessSummary} />
        )}
        <Detail label="GAS版" value={account.gas.version || "不明"} />
        <Detail
          label="トークン自動更新"
          value={account.gas.hasTokenRefreshTrigger === null ? "不明" : account.gas.hasTokenRefreshTrigger ? "あり" : "なし"}
          tone={account.gas.hasTokenRefreshTrigger === false ? "warning" : "neutral"}
        />
        <Detail
          label="トークン状態"
          value={account.gas.tokenStatus === "failed" ? "更新失敗" : account.gas.tokenStatus === "expiring_soon" ? "期限が近い" : account.gas.tokenStatus === "ok" ? "正常" : "不明"}
          tone={account.gas.tokenStatus === "failed" ? "error" : account.gas.tokenStatus === "expiring_soon" ? "warning" : "neutral"}
        />
        <Detail label="タイムゾーン" value={account.gas.scriptTimeZone || "不明"} />
        <Detail label="トークン期限" value={formatFullDateTime(account.tokenExpiresAt)} />
        {account.gas.tokenLastError && (
          <Detail label="トークン更新エラー" value={account.gas.tokenLastError} tone="error" />
        )}
      </div>
    </details>
  );
}

function RecentErrorGuide({ account }: { account: AccountStatus }) {
  return (
    <div className="sm:col-span-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs leading-relaxed text-red-800">
      <div className="font-bold">ここがエラーです（直近24時間: {account.error24h}件）</div>
      <div className="mt-1 text-red-700">
        左メニューの「エラー」を開くと、失敗した投稿だけを確認できます。下に最近の失敗内容を表示しています。
      </div>
      <ol className="mt-2 list-decimal space-y-1 pl-4 text-red-700">
        <li>左メニューの「エラー」を開き、赤く表示された投稿を確認します。</li>
        <li>直前の投稿反映待ちなど一時的な失敗なら「失敗分だけ再試行」を押してください。投稿済み部分は触りません。</li>
        <li>本文を直す場合は「失敗分だけ下書きへ」で戻してから編集し、もう一度キューに追加してください。</li>
        <li>原因が分からない場合は、この画面下の「サポート用レポートをコピー」を押して送ってください。</li>
      </ol>
      {account.recentErrors.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {account.recentErrors.map((post) => (
            <div key={post.id} className="rounded border border-red-100 bg-red-50 px-2 py-1.5">
              <div className="font-semibold text-red-800">
                #{post.groupNo.toString().padStart(2, "0")} / {formatFullDateTime(post.updatedAt)}
              </div>
              <div className="mt-0.5 break-words text-red-700">
                {post.error || "エラー内容が保存されていません。投稿一覧で詳細を確認してください。"}
              </div>
              <div className="mt-0.5 break-words text-[11px] text-red-500">
                {post.bodyPreview}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type DetailTone = "neutral" | "warning" | "error";

const detailToneClass: Record<DetailTone, string> = {
  neutral: "border-gray-100 bg-gray-50 text-gray-700",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  error: "border-red-200 bg-red-50 text-red-800",
};

function Detail({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: DetailTone;
}) {
  return (
    <div className={`rounded border px-2 py-1.5 ${detailToneClass[tone]}`}>
      <span className={tone === "neutral" ? "text-gray-400" : "font-semibold"}>
        {label}:{" "}
      </span>
      <span className="break-words">{value}</span>
    </div>
  );
}
