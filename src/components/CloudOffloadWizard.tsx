"use client";

import { useEffect, useState } from "react";

type Account = {
  id: string;
  name: string;
  accessToken: string | null;
  cloudOffloadEnabled: boolean;
  gasWebAppUrl: string | null;
  gasWebAppKey: string | null;
  gasSpreadsheetId: string | null;
  lastSyncedAt?: string | null;
  tokenFingerprint?: string | null;
  tokenExpiresAt?: string | null;
};

type SyncResult = {
  ok: boolean;
  fetched: number;
  applied: number;
  acked: number;
  tokenStatus?: "ok" | "expiring_soon" | "failed";
  tokenExpiresAt?: string | null;
  recentErrorCount24h?: number;
  error?: string;
};

const REPAIR_TIMEOUT_MS = 150_000;

function formatElapsed(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s.toString().padStart(2, "0")}秒` : `${s}秒`;
}

type Step = "intro" | "credentials" | "test" | "initialize" | "ready";

type HealthData = {
  ok?: boolean;
  version?: string;
  configured?: boolean;
  hasTrigger?: boolean;
  hasTokenRefreshTrigger?: boolean;
  userId?: string | null;
  tokenFingerprint?: string | null;
  scriptTimeZone?: string | null;
  spreadsheetTimeZone?: string | null;
  pendingVerification?: boolean;
  verified?: boolean;
  gasWebAppUrl?: string;
  urlChanged?: boolean;
};

export default function CloudOffloadWizard({
  account,
  onChange,
}: {
  account: Account;
  onChange: () => void;
}) {
  const [step, setStep] = useState<Step>(account.gasWebAppUrl ? "ready" : "intro");
  const [url, setUrl] = useState(account.gasWebAppUrl || "");
  const [key, setKey] = useState(account.gasWebAppKey || "");
  const [spreadsheetId, setSpreadsheetId] = useState(account.gasSpreadsheetId || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<HealthData | null>(null);
  const [info, setInfo] = useState("");
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // ターミナルの setup-cloud.sh などで外部から初期化された場合、
  // この画面を開いたまま（=未操作なので step は "intro"）でも、
  // 親が /api/accounts を取り直して account が更新されたら自動で「準備済み」表示に切り替える。
  useEffect(() => {
    if (account.gasWebAppUrl && step === "intro") {
      setUrl(account.gasWebAppUrl);
      setKey(account.gasWebAppKey || "");
      setSpreadsheetId(account.gasSpreadsheetId || "");
      setStep("ready");
    }
  }, [account.gasWebAppUrl, account.gasWebAppKey, account.gasSpreadsheetId, step]);

  // 修復／確認の実行中（busy）に経過時間を毎秒更新（生成中アニメと同じ体験）
  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    setElapsedSec(0);
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  async function runSyncNow() {
    setBusy(true);
    setError("");
    setInfo("");
    setSyncResult(null);
    try {
      const r = await fetch(`/api/cloud/sync?accountId=${account.id}`);
      const j: SyncResult = await r.json();
      setSyncResult(j);
      if (j.ok) {
        setInfo(`同期完了: 取得${j.fetched}件 / DB反映${j.applied}件 / ack${j.acked}件`);
        onChange();
      } else {
        setError(j.error || "同期失敗");
      }
    } catch (e) {
      setError("同期エラー: " + String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runRepairCloudPosting() {
    setBusy(true);
    setError("");
    setInfo("Google側へコードを送っています。通常1〜2分で終わります。この画面のままお待ちください。");
    setSyncResult(null);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), REPAIR_TIMEOUT_MS);
    try {
      const r = await fetch("/api/cloud/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ action: "repairCloudPosting", accountId: account.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Google投稿の修復に失敗しました");
        setInfo("");
      } else {
        setInfo(
          (j.message || "Google投稿を修復しました") +
            (j.urlChanged ? " 動作するGoogle側URLへ自動で更新しました。" : "") +
            (j.repairedQueued ? ` 予約${j.repairedQueued}件をGoogle側で確認しました。` : "")
        );
        setHealth(j);
        onChange();
      }
    } catch (e) {
      setInfo("");
      if (e instanceof DOMException && e.name === "AbortError") {
        setError(
          "Google投稿の修復確認が2分以上終わらなかったため中止しました。Google側の反映待ちの可能性があります。少し待ってからもう一度押してください。"
        );
      } else {
        setError("Google投稿の修復エラー: " + String(e));
      }
    } finally {
      window.clearTimeout(timer);
      setBusy(false);
    }
  }

  async function runVerifyStatus() {
    const checkUrl = (account.gasWebAppUrl || url).trim();
    const checkKey = (account.gasWebAppKey || key).trim();
    if (!checkUrl || !checkKey) {
      setError("Google連携のURL/Keyがまだ保存されていません。先にクラウドオフロードをセットアップしてください。");
      return;
    }
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const r = await fetch("/api/cloud/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "healthCheck",
          accountId: account.id,
          gasWebAppUrl: checkUrl,
          gasWebAppKey: checkKey,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setHealth(null);
        setError(j.error || "Google側の状態を確認できませんでした");
      } else {
        setHealth(j);
        const ready =
          j.configured &&
          j.hasTrigger &&
          j.version &&
          j.scriptTimeZone === "Asia/Tokyo" &&
          /^webapp-v1\.(?:[1-9]\d*)\.(?:[5-9]|\d{2,})$|^webapp-v[2-9]\./.test(j.version);
        setInfo(
          ready
            ? "確認OK: Google側は予約投稿できる状態です。"
            : "確認しました。赤い項目がある場合は、予約を入れる前に対応してください。"
        );
      }
    } catch (e) {
      setError("確認エラー: " + String(e));
    } finally {
      setBusy(false);
    }
  }

  async function generateKey() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/cloud/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generateKey" }),
      });
      const j = await r.json();
      if (j.key) setKey(j.key);
    } catch (e) {
      setError("key生成失敗: " + String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runHealthCheck() {
    setBusy(true);
    setError("");
    setHealth(null);
    try {
      const r = await fetch("/api/cloud/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "healthCheck",
          accountId: account.id,
          gasWebAppUrl: url.trim(),
          gasWebAppKey: key.trim(),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "疎通失敗");
      } else {
        setHealth(j);
        setStep("initialize");
      }
    } catch (e) {
      setError("疎通エラー: " + String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runInitialize() {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const r = await fetch("/api/cloud/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "initialize",
          accountId: account.id,
          gasWebAppUrl: url.trim(),
          gasWebAppKey: key.trim(),
          gasSpreadsheetId: spreadsheetId.trim() || null,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "initialize失敗");
      } else {
        setInfo(`GAS側初期化完了（@${j.username || "?"} / userId=${j.userId || "?"}）`);
        setStep("ready");
        onChange();
      }
    } catch (e) {
      setError("initializeエラー: " + String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runEnable() {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const r = await fetch("/api/cloud/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enable", accountId: account.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) setError(j.error || "有効化失敗");
      else {
        setInfo(j.message);
        onChange();
      }
    } catch (e) {
      setError("エラー: " + String(e));
    } finally {
      setBusy(false);
    }
  }

  const isInitialized = !!account.gasWebAppUrl && !!account.gasWebAppKey;
  const isEnabled = account.cloudOffloadEnabled;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-gray-700">
              ☁ クラウドオフロード（PCを閉じても投稿）
            </span>
            {isEnabled && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">
                有効
              </span>
            )}
            {!isEnabled && isInitialized && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">
                準備済（無効）
              </span>
            )}
            {!isInitialized && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                未セットアップ
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            スプシ＋GASの時間トリガーが投稿を担当します。Macが起動していなくても予約投稿が動きます。
            複数アカウントを使う場合も、アプリがアカウントごとに別々のGoogle連携を使います。
          </p>
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">
          {error}
        </div>
      )}
      {info && (
        <div className="text-xs text-green-700 bg-green-50 px-3 py-2 rounded">
          {busy ? (
            <div className="flex items-center gap-2">
              <svg
                className="h-4 w-4 shrink-0 animate-spin text-green-600"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span className="flex-1 whitespace-pre-wrap">{info}</span>
              <span className="shrink-0 tabular-nums opacity-70">{formatElapsed(elapsedSec)}</span>
            </div>
          ) : (
            info
          )}
        </div>
      )}

      {/* 初期化済み → 有効/無効トグル + 同期状態 */}
      {step === "ready" && isInitialized && (
        <div className="space-y-2">
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-[12px] leading-relaxed text-sky-900">
            <div className="font-bold">Google投稿の修復</div>
            Google側のコード・自動実行・タイムゾーン・投稿用トークンをまとめて確認し、動作するURLを保存し直します。
            予約が残っている場合は、Google側に本当に入ったことまで確認します。
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                disabled={busy}
                onClick={runRepairCloudPosting}
                className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
              >
                {busy ? "修復中...（最大2分）" : "Google投稿を修復する"}
              </button>
              <button
                disabled={busy}
                onClick={runVerifyStatus}
                className="rounded bg-white px-3 py-1.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200 hover:bg-sky-50 disabled:opacity-50"
              >
                {busy ? "確認中..." : "Google側の状態を確認"}
              </button>
            </div>
          </div>
          {health && (
            <div className="rounded-lg border border-gray-100 bg-white px-3 py-2 text-[11px] text-gray-700">
              <div className="mb-1 font-bold text-gray-800">Google側の現在状態</div>
              <div className="grid gap-1 sm:grid-cols-2">
                <CloudStatusItem label="GAS版" value={health.version || "不明"} ok={!!health.version && !health.pendingVerification} />
                <CloudStatusItem label="自動実行" value={health.hasTrigger ? "あり" : "なし"} ok={health.hasTrigger === true} />
                <CloudStatusItem label="初期設定" value={health.configured ? "完了" : "未完了"} ok={health.configured === true} />
                <CloudStatusItem label="タイムゾーン" value={health.scriptTimeZone || "不明"} ok={health.scriptTimeZone === "Asia/Tokyo"} />
              </div>
              {health.pendingVerification ? (
                <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-amber-700">
                  Google側の確認が終わっていません。この状態では予約をクラウドへ送りません。
                </div>
              ) : health.configured && health.hasTrigger && health.scriptTimeZone === "Asia/Tokyo" ? (
                <div className="mt-2 rounded bg-emerald-50 px-2 py-1 text-emerald-700">
                  Google側は予約投稿できる状態です。
                </div>
              ) : (
                <div className="mt-2 rounded bg-red-50 px-2 py-1 text-red-700">
                  この状態では予約投稿が止まる可能性があります。赤い項目を直してから予約してください。
                </div>
              )}
              {health.urlChanged && (
                <div className="mt-2 rounded bg-sky-50 px-2 py-1 text-sky-700">
                  Google側のURLが変わっていたため、アプリ側の保存URLも自動で更新しました。
                </div>
              )}
            </div>
          )}
          {/* 有効時の「これで何が起きるか／次は何をすればいいか」案内 */}
          {isEnabled && (
            <div className="text-[12px] leading-relaxed text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5">
              <div className="font-bold mb-0.5">✓ クラウドオフロード有効 — 設定でやることはもうありません</div>
              これで <b>PC を閉じていても・スリープ中でも・電源オフでも、予約時刻になれば自動で投稿されます</b>（Google 側が肩代わりします）。
              <br />
              使い方は今までどおりです：投稿を作って「<b>全件キューに追加</b>」で予約すればOK。あとは自動で投稿されます。
              <br />
              <span className="text-emerald-700">下の「最終同期」が更新されていれば正常に動いています（5分おきに同期）。トークンの期限も自動で更新されます。</span>
            </div>
          )}
          <div className="text-[11px] text-gray-600 space-y-0.5 font-mono break-all">
            <div>URL: {account.gasWebAppUrl}</div>
            <div>Key: ********{account.gasWebAppKey?.slice(-4) || ""}</div>
            {account.gasSpreadsheetId && <div>SS: {account.gasSpreadsheetId}</div>}
          </div>
          {/* 同期状態（クラウドオフロード有効時のみ表示） */}
          {isEnabled && (
            <div className="text-[11px] text-gray-600 space-y-0.5 bg-white border border-gray-100 rounded p-2">
              <div>
                最終同期:{" "}
                {account.lastSyncedAt
                  ? new Date(account.lastSyncedAt).toLocaleString("ja-JP")
                  : "未同期"}
              </div>
              {account.tokenFingerprint && (
                <div>token: {account.tokenFingerprint}</div>
              )}
              {account.tokenExpiresAt && (
                <div>
                  期限: {new Date(account.tokenExpiresAt).toLocaleDateString("ja-JP")}
                  {(() => {
                    const ms = new Date(account.tokenExpiresAt).getTime() - Date.now();
                    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
                    if (days < 0)
                      return <span className="text-red-600 ml-1">（期限切れ）</span>;
                    if (days < 7)
                      return (
                        <span className="text-amber-600 ml-1">（残り{days}日）</span>
                      );
                    return <span className="text-gray-400 ml-1">（残り{days}日）</span>;
                  })()}
                </div>
              )}
              {syncResult && syncResult.ok && (
                <div className="text-[10px] text-gray-500 mt-1">
                  直近同期: 取得{syncResult.fetched} / 反映{syncResult.applied} / ack
                  {syncResult.acked}
                  {syncResult.recentErrorCount24h !== undefined &&
                    syncResult.recentErrorCount24h > 0 && (
                      <span className="text-red-500 ml-2">
                        24h以内エラー: {syncResult.recentErrorCount24h}件
                      </span>
                    )}
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {!isEnabled ? (
              <button
                disabled={busy}
                onClick={runEnable}
                className="px-3 py-1.5 rounded text-xs font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
              >
                {busy ? "..." : "クラウドオフロードを有効化"}
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={runSyncNow}
                className="px-3 py-1.5 rounded text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? "..." : "今すぐ同期"}
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => setStep("credentials")}
              className="rounded bg-gray-100 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-200 disabled:opacity-50"
            >
              接続情報を変更
            </button>
          </div>
        </div>
      )}

      {/* 初期セットアップ */}
      {step === "intro" && !isInitialized && (
        <div className="space-y-2">
          <div className="text-[11px] text-amber-700 bg-amber-100/60 rounded px-2.5 py-2 leading-relaxed">
            ⚠️ 「未セットアップ」のままだと、<b>PCがスリープ／電源オフの間は予約投稿が止まります</b>（PC起動中だけ投稿されます）。
            PCを閉じていても投稿させたい場合は、ここをセットアップしてください。
            <br />
            複数アカウントを使う場合も、通常は自動セットアップがアカウントごとに別々のGoogle連携を用意します。
            ユーザーが自分でスプレッドシートを作る必要はありません。
          </div>
          <div className="text-[11px] text-gray-600 leading-relaxed">
            かんたんなのは <b>自動セットアップ</b>です。ターミナル（このツールのフォルダ）で次を実行してください：
            <code className="block mt-1 px-2 py-1 rounded bg-gray-100 font-mono text-[11px]">bash setup-cloud.sh</code>
            <span className="text-gray-400">（Claude Code に「クラウドオフロードをセットアップして」と頼んでもOK）</span>
          </div>
          <details className="text-[11px] text-gray-500">
            <summary className="cursor-pointer hover:text-gray-700">手動でやる場合の手順を表示</summary>
            <ol className="mt-1 space-y-1 list-decimal list-inside">
              <li>このアカウント専用のGoogleスプレッドシートを1つ作成</li>
              <li>拡張機能 → Apps Script を開き、gas/appscript.gs と appsscript.json を貼付</li>
              <li>デプロイ → 新しいデプロイ → ウェブアプリ（実行=自分、アクセス=全員）</li>
              <li>表示されたURLをコピー、下にペースト</li>
              <li>「Key生成」ボタンで認証キーを作成し、両方を保存</li>
            </ol>
            <button
              onClick={() => setStep("credentials")}
              className="mt-2 px-3 py-1.5 rounded text-xs font-medium text-white bg-blue-600 hover:bg-blue-700"
            >
              手動セットアップを開始
            </button>
          </details>
        </div>
      )}

      {(step === "credentials" || step === "test" || step === "initialize") && (
        <div className="space-y-2">
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">
              GAS Web App URL
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://script.google.com/macros/s/.../exec"
              className="w-full px-2 py-1.5 rounded border border-gray-200 text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">
              認証キー（WEBAPP_KEY）
            </label>
            <div className="flex gap-1">
              <input
                type="text"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="ランダム文字列"
                className="flex-1 px-2 py-1.5 rounded border border-gray-200 text-xs font-mono"
              />
              <button
                onClick={generateKey}
                disabled={busy}
                className="px-2 py-1 rounded text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50"
              >
                Key生成
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">
              スプレッドシートID（任意・参考用）
            </label>
            <input
              type="text"
              value={spreadsheetId}
              onChange={(e) => setSpreadsheetId(e.target.value)}
              placeholder="docs.google.com/spreadsheets/d/<ここ>/edit"
              className="w-full px-2 py-1.5 rounded border border-gray-200 text-xs font-mono"
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={runHealthCheck}
              disabled={busy || !url || !key}
              className="px-3 py-1.5 rounded text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? "確認中..." : "①疎通テスト"}
            </button>
            {step === "initialize" && health && (
              <button
                onClick={runInitialize}
                disabled={busy || !account.accessToken}
                className="px-3 py-1.5 rounded text-xs font-medium text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
              >
                {busy ? "送信中..." : "②GAS初期化（トークン送信）"}
              </button>
            )}
          </div>

          {health && (
            <div className="text-[11px] text-gray-600 bg-white border border-gray-100 rounded p-2 space-y-0.5">
              <div>version: {health.version}</div>
              <div>configured: {String(health.configured)}</div>
              <div>hasTrigger: {String(health.hasTrigger)}</div>
              {health.userId && <div>userId: {health.userId}</div>}
              {health.tokenFingerprint && (
                <div>token: {health.tokenFingerprint}</div>
              )}
            </div>
          )}
          {!account.accessToken && (
            <div className="text-[11px] text-amber-600">
              ⚠ アクセストークンが未保存です。先に上のフォームでトークンを保存してから「②GAS初期化」を実行してください。
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CloudStatusItem({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className={`rounded px-2 py-1 ${ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
      <span className="text-gray-500">{label}: </span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
