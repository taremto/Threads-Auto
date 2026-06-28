"use client";

import { useState, useEffect } from "react";
import { getJSON, postJSON } from "@/lib/api";
import {
  buildGenerationCountOptions,
  dailyPostCountFromPostingHours,
  generationCountLabel,
  MAX_GENERATE_POSTS,
} from "@/lib/account-posting";

type Account = {
  id: string;
  name: string;
  threadsUsername: string | null;
  conceptSheet: string | null;
  postingHours: string;
  postsPerDay: number;
};

type ClaudeStatus = {
  ok: boolean;
  billingBlocked: boolean;
  title: string;
  message: string;
  nextAction: string;
  version: string | null;
  command: string | null;
  riskEnvNames: string[];
};

type ClaudeUsageStatus = {
  available: boolean;
  status: "safe" | "caution" | "danger" | "blocked" | "unknown";
  title: string;
  message: string;
  nextAction: string;
  checkedAt: string;
  source: "live" | "cache" | "claude-cache" | "unavailable" | "no-cache" | "error";
  fiveHour: { usedPercentage: number | null; resetsAt: string | null; resetText: string | null };
  sevenDay: { usedPercentage: number | null; resetsAt: string | null; resetText: string | null };
  contextWindow?: { usedPercentage: number | null; resetsAt: string | null; resetText: string | null };
  plan?: { usedPercentage: number | null; resetsAt: string | null; resetText: string | null };
  maxRecommendedPosts: number | null;
};

type GenerateModalProps = {
  currentAccountId: string | null;
  onClose: () => void;
  onGenerated: () => void;
};

type AiProvider = "auto" | "claude" | "codex";

export default function GenerateModal({
  currentAccountId,
  onClose,
  onGenerated,
}: GenerateModalProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    currentAccountId || ""
  );
  const [postCount, setPostCount] = useState(4);
  const [postCountTouched, setPostCountTouched] = useState(false);
  const [extraInstructions, setExtraInstructions] = useState("");
  const [provider, setProvider] = useState<AiProvider>("auto");
  const [generating, setGenerating] = useState(false);
  const [checkingClaude, setCheckingClaude] = useState(true);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [checkingUsage, setCheckingUsage] = useState(true);
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsageStatus | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    getJSON<Account[]>("/api/accounts")
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setAccounts(list);
        if (!selectedAccountId && list.length > 0) {
          setSelectedAccountId(list[0].id);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [selectedAccountId]);

  useEffect(() => {
    getJSON<ClaudeStatus>("/api/generate/status")
      .then((data) => setClaudeStatus(data))
      .catch(() =>
        setClaudeStatus({
          ok: false,
          billingBlocked: false,
          title: "Claudeの確認に失敗しました",
          message: "AI生成の準備状態を確認できませんでした。",
          nextAction:
            "Claudeデスクトップアプリを開いて、このフォルダを選び、「AI生成の準備を確認して」と送ってください。",
          version: null,
          command: null,
          riskEnvNames: [],
        })
      )
      .finally(() => setCheckingClaude(false));
  }, []);

  async function fetchClaudeUsage(refresh = false) {
    setCheckingUsage(true);
    try {
      const data = await getJSON<ClaudeUsageStatus>(
        `/api/generate/usage${refresh ? "?refresh=1" : ""}`
      );
      setClaudeUsage(data);
    } catch {
      setClaudeUsage({
        available: false,
        status: "unknown",
        title: "Claude使用量を確認できません",
        message:
          "使用量の数字を自動取得できませんでした。生成はできますが、上限が不安な場合は少なめにしてください。",
        nextAction: "まず2〜4投稿だけ生成してください。",
        checkedAt: new Date().toISOString(),
        source: "error",
        fiveHour: { usedPercentage: null, resetsAt: null, resetText: null },
        sevenDay: { usedPercentage: null, resetsAt: null, resetText: null },
        maxRecommendedPosts: null,
      });
    } finally {
      setCheckingUsage(false);
    }
  }

  useEffect(() => {
    fetchClaudeUsage(false);
  }, []);

  // 生成中の経過時間カウンタ（毎秒更新）。完了 or 未生成では止める
  useEffect(() => {
    if (!generating || done) return;
    const startedAt = Date.now();
    setElapsedSec(0);
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [generating, done]);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const dailyCount = selectedAccount
    ? dailyPostCountFromPostingHours(selectedAccount.postingHours)
    : 4;
  const usageMaxPosts = claudeUsage?.maxRecommendedPosts ?? null;
  const usageHardBlocked = usageMaxPosts === 0 || claudeUsage?.status === "blocked";
  const claudeOnly = provider === "claude";
  const countLimit =
    claudeOnly && typeof usageMaxPosts === "number" && usageMaxPosts > 0
      ? Math.min(usageMaxPosts, MAX_GENERATE_POSTS)
      : MAX_GENERATE_POSTS;

  // アカウントの設定本数（投稿時間帯の数）を初期値に反映する。
  // ユーザーが本数を手で変えていない間は、選択アカウントに追従させる。
  useEffect(() => {
    if (!selectedAccount || postCountTouched) return;
    queueMicrotask(() => setPostCount(dailyCount));
  }, [dailyCount, selectedAccount, postCountTouched]);

  useEffect(() => {
    if (!claudeOnly) return;
    if (typeof usageMaxPosts !== "number" || usageMaxPosts <= 0) return;
    if (postCount > usageMaxPosts) {
      queueMicrotask(() => {
        setPostCount(usageMaxPosts);
        setPostCountTouched(true);
      });
    }
  }, [claudeOnly, postCount, usageMaxPosts]);

  const countOptions = buildGenerationCountOptions(dailyCount, countLimit);

  const usageBlockedByCount =
    claudeOnly &&
    typeof usageMaxPosts === "number" &&
    usageMaxPosts > 0 &&
    postCount > usageMaxPosts;

  const usageCardClass =
    checkingUsage || !claudeUsage
      ? "bg-gray-50 border-gray-200 text-gray-600"
      : claudeUsage.status === "blocked" || claudeUsage.status === "danger"
        ? "bg-red-50 border-red-200 text-red-700"
        : claudeUsage.status === "caution"
          ? "bg-yellow-50 border-yellow-200 text-yellow-700"
          : "bg-gray-50 border-gray-200 text-gray-700";

  function usageMeter(
    label: string,
    usage: { usedPercentage: number | null; resetText: string | null }
  ) {
    const pct = usage.usedPercentage;
    if (pct === null) return null;
    return { label, pct, resetText: usage.resetText };
  }

  function usageMeters(status: ClaudeUsageStatus) {
    return [
      usageMeter("現在のセッション", status.fiveHour),
      usageMeter("週間制限", status.sevenDay),
      status.plan ? usageMeter("プラン", status.plan) : null,
    ].filter(
      (meter): meter is { label: string; pct: number; resetText: string | null } =>
        Boolean(meter)
    );
  }

  function usageBarColor(pct: number) {
    if (pct >= 90) return "bg-red-500";
    if (pct >= 75) return "bg-yellow-500";
    return "bg-blue-500";
  }

  function generationWaitText(count: number) {
    if (count >= 12) return "5〜15分ほど";
    if (count >= 8) return "3〜8分ほど";
    return "1〜3分ほど";
  }

  // 疑似プログレスバー用の推定総時間（秒）。generationWaitText の中央値イメージ
  function estimatedTotalSec(count: number) {
    if (count >= 12) return 600;
    if (count >= 8) return 330;
    return 150;
  }

  function formatElapsed(sec: number) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}分${s.toString().padStart(2, "0")}秒` : `${s}秒`;
  }

  async function handleGenerate() {
    if (!selectedAccountId) return;
    if (claudeOnly && checkingClaude) return;
    if (claudeOnly && claudeStatus && !claudeStatus.ok) {
      setError(`${claudeStatus.title}\n${claudeStatus.message}\n${claudeStatus.nextAction}`);
      return;
    }
    if (claudeOnly && usageHardBlocked && claudeUsage) {
      setError(`${claudeUsage.title}\n${claudeUsage.message}\n${claudeUsage.nextAction}`);
      return;
    }
    if (
      claudeOnly &&
      usageBlockedByCount &&
      claudeUsage &&
      usageMaxPosts
    ) {
      setError(
        `${claudeUsage.title}\n${claudeUsage.message}\n${claudeUsage.nextAction}\n\n今回は${usageMaxPosts}投稿以下に減らしてください。`
      );
      return;
    }

    setDone(false);
    setElapsedSec(0);
    setGenerating(true);
    setError("");
    const providerLabel =
      provider === "codex"
        ? "Codex"
        : provider === "claude"
          ? "Claude"
          : "AI（Claude→Codex自動切替）";
    setProgress(
      `${providerLabel}で投稿を生成中…（${generationWaitText(postCount)}かかります。このまま閉じずにお待ちください）`
    );

    try {
      const data = await postJSON<{
        count: number;
        skippedSimilar?: number;
        providerUsed?: "claude" | "codex";
        fallbackFrom?: "claude";
      }>(
        "/api/generate",
        {
          accountId: selectedAccountId,
          count: postCount,
          extraInstructions: extraInstructions.trim() || undefined,
          provider,
        }
      );
      const usedLabel =
        data.providerUsed === "codex"
          ? data.fallbackFrom === "claude"
            ? "ClaudeからCodexへ自動切替"
            : "Codex"
          : "Claude";
      setDone(true);
      setProgress(
        `${usedLabel}で${data.count}件の投稿を生成しました` +
          (data.skippedSimilar
            ? `（過去投稿と似ていた${data.skippedSimilar}件は自動でスキップ）`
            : "")
      );
      setTimeout(() => onGenerated(), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成に失敗しました");
      setGenerating(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <h3 className="text-lg font-bold text-gray-800 mb-4">AI投稿生成</h3>

        {/* アカウント選択 */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-600 mb-1">
            アカウント
          </label>
          <select
            value={selectedAccountId}
            onChange={(e) => {
              setSelectedAccountId(e.target.value);
              setPostCountTouched(false);
            }}
            disabled={generating}
            className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.threadsUsername ? ` (@${a.threadsUsername})` : ""}
              </option>
            ))}
          </select>
        </div>

        {/* 生成AI選択 */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-600 mb-1">
            生成AI
          </label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as AiProvider)}
            disabled={generating}
            className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
          >
            <option value="auto">自動切替（Claude → Codex）</option>
            <option value="codex">Codexを使う</option>
            <option value="claude">Claudeを使う</option>
          </select>
          <p className="mt-1 text-xs text-gray-500">
            自動切替は、Claudeの利用制限・エラー時にCodexへ切り替えます。どちらも月額プランのログインを使い、APIキーは使いません。
          </p>
        </div>

        {/* コンセプト未設定の警告 */}
        {selectedAccount && !selectedAccount.conceptSheet && (
          <div className="mb-4 p-3 rounded-lg bg-yellow-50 border border-yellow-200 text-sm text-yellow-700">
            このアカウントのコンセプトシートが未設定です。設定画面から入力してください。
          </div>
        )}

        {provider === "codex" ? (
          <div className="mb-4 p-3 rounded-lg border border-green-200 bg-green-50 text-sm leading-relaxed text-green-700">
            <div className="font-bold">Codexで生成します</div>
            <div className="mt-1">
              ChatGPTログインを使い、読み取り専用の一時セッションで投稿文を生成します。
            </div>
          </div>
        ) : (
          <>
          {/* Claudeの安全チェック */}
          <div
          className={`mb-4 p-3 rounded-lg border text-sm leading-relaxed ${
            checkingClaude
              ? "bg-gray-50 border-gray-200 text-gray-600"
              : claudeStatus?.ok
                ? "bg-green-50 border-green-200 text-green-700"
                : "bg-red-50 border-red-200 text-red-700"
          }`}
        >
          <div className="font-bold">
            {checkingClaude
              ? "Claudeの準備を確認しています"
              : claudeStatus?.title || "Claudeの状態を確認できませんでした"}
          </div>
          {!checkingClaude && claudeStatus && (
            <>
              <div className="mt-1">{claudeStatus.message}</div>
              {!claudeStatus.ok && (
                <div className="mt-2 font-medium">{claudeStatus.nextAction}</div>
              )}
              {claudeStatus.ok && (
                <div className="mt-1 text-xs text-green-600">
                  月額プランで使う前提の安全チェックOK
                  {claudeStatus.version ? ` / ${claudeStatus.version}` : ""}
                </div>
              )}
            </>
          )}
          </div>

          {/* Claude使用量チェック */}
          <div className={`mb-4 p-3 rounded-lg border text-sm leading-relaxed ${usageCardClass}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="font-bold">
              {checkingUsage
                ? "使用量を確認中"
                : "プラン使用制限"}
            </div>
            <button
              type="button"
              onClick={() => fetchClaudeUsage(true)}
              disabled={checkingUsage || generating}
              className="shrink-0 px-2 py-1 rounded border border-current text-xs font-medium opacity-80 hover:opacity-100 disabled:opacity-40"
            >
              再確認
            </button>
          </div>
          {checkingUsage && (
            <div className="mt-1 text-xs opacity-75">
              最新の使用率を取得しています（最大1分ほどかかります）。このまま少しお待ちください。
            </div>
          )}
          {!checkingUsage && claudeUsage && (
            <>
              {usageMeters(claudeUsage).length > 0 ? (
                <div className="mt-3 space-y-4">
                  {usageMeters(claudeUsage).map((meter) => (
                    <div key={meter.label}>
                      <div className="flex items-end justify-between gap-3">
                        <div>
                          <div className="font-medium">{meter.label}</div>
                          {meter.resetText && (
                            <div className="text-xs opacity-75">{meter.resetText}</div>
                          )}
                        </div>
                        <div className="text-xs font-medium">{meter.pct}% 使用済み</div>
                      </div>
                      <div className="mt-2 h-2 rounded-full bg-gray-200 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${usageBarColor(meter.pct)}`}
                          style={{ width: `${Math.max(0, Math.min(100, meter.pct))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : claudeUsage.status !== "unknown" ? (
                <div className="mt-2 space-y-1">
                  <div className="text-sm font-medium">{claudeUsage.title}</div>
                  <div className="text-xs opacity-75">{claudeUsage.message}</div>
                  {claudeUsage.nextAction && (
                    <div className="text-xs opacity-75">{claudeUsage.nextAction}</div>
                  )}
                </div>
              ) : claudeUsage.source === "no-cache" ? (
                <div className="mt-2 space-y-1">
                  <div className="text-sm font-medium">{claudeUsage.title}</div>
                  <div className="text-xs opacity-75">{claudeUsage.message}</div>
                  {claudeUsage.nextAction && (
                    <div className="text-xs opacity-75">{claudeUsage.nextAction}</div>
                  )}
                </div>
              ) : (
                <div className="mt-2 text-xs opacity-75">使用量を取得できません</div>
              )}
            </>
          )}
          </div>
          </>
        )}

        {/* 投稿数指定 */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-600 mb-1">
            生成する投稿数
          </label>
          <select
            value={postCount}
            onChange={(e) => {
              setPostCount(Number(e.target.value));
              setPostCountTouched(true);
            }}
            disabled={generating || (claudeOnly && usageHardBlocked)}
            className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
          >
            {countOptions.map((n) => (
              <option key={n} value={n}>
                {generationCountLabel(n, dailyCount)}
              </option>
            ))}
          </select>
          {claudeOnly &&
            typeof usageMaxPosts === "number" &&
            usageMaxPosts > 0 && (
            <div className="mt-2 text-xs text-gray-500">
              Claude使用量が多いため、今回は{usageMaxPosts}投稿まで選べます。
            </div>
            )}
        </div>

        {/* 追加指示（任意） */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-600 mb-1">
            追加指示（任意）
          </label>
          <textarea
            value={extraInstructions}
            onChange={(e) => setExtraInstructions(e.target.value)}
            disabled={generating}
            rows={4}
            placeholder={`例:\n・今回は「退職を伝える勇気が出ない」テーマだけに絞って\n・スレッドの最後に無料相談へのCTAを必ず1本入れる\n・○○というキーワードは使わない`}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300 resize-y leading-relaxed"
          />
          <p className="mt-1 text-xs text-gray-500">
            コンセプト・ナレッジに加えて、今回だけの追加指示を書けます（テーマ縛り・CTA有無・禁止表現など）。空欄でもOK。
          </p>
        </div>

        {/* エラー表示 */}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 whitespace-pre-wrap leading-relaxed">
            {error}
          </div>
        )}

        {/* 進捗表示（生成中はスピナー＋経過時間＋疑似プログレス、完了で緑チェック） */}
        {generating && progress && (
          <div className="mb-4 p-4 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 leading-relaxed">
            <div className="flex items-center gap-3">
              {done ? (
                <svg
                  className="h-5 w-5 shrink-0 text-green-500"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg
                  className="h-5 w-5 shrink-0 animate-spin text-blue-500"
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
              )}
              <div className="flex-1 text-sm whitespace-pre-wrap">{progress}</div>
            </div>
            {!done && (
              <div className="mt-3">
                <div className="flex justify-between text-xs text-blue-500 mb-1">
                  <span>経過 {formatElapsed(elapsedSec)}</span>
                  <span>目安 {generationWaitText(postCount)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-blue-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-blue-400 transition-all duration-1000 ease-linear"
                    style={{
                      width: `${Math.min(95, (elapsedSec / estimatedTotalSec(postCount)) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* ボタン */}
        <div className="flex gap-3">
          <button
            onClick={handleGenerate}
            disabled={
              generating ||
              (claudeOnly && checkingClaude) ||
              !selectedAccountId ||
              !!(claudeOnly && claudeStatus && !claudeStatus.ok) ||
              (claudeOnly && usageHardBlocked) ||
              usageBlockedByCount
            }
            className="flex-1 px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {generating ? "生成中..." : "生成開始"}
          </button>
          <button
            onClick={onClose}
            disabled={generating}
            className="px-5 py-2.5 rounded-lg text-sm font-medium text-gray-600 bg-gray-100 transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
