"use client";

import { useState, useEffect } from "react";
import { getJSON, postJSON } from "@/lib/api";

type Account = {
  id: string;
  name: string;
  threadsUsername: string | null;
  conceptSheet: string | null;
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

type GenerateModalProps = {
  currentAccountId: string | null;
  onClose: () => void;
  onGenerated: () => void;
};

const BASE_COUNT_OPTIONS = [2, 4, 6, 8, 10, 12, 16, 20];

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
  const [generating, setGenerating] = useState(false);
  const [checkingClaude, setCheckingClaude] = useState(true);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

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

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  // アカウントの設定本数（postsPerDay）を初期値に反映する。
  // ユーザーが本数を手で変えていない間は、選択アカウントに追従させる。
  useEffect(() => {
    if (!selectedAccount || postCountTouched) return;
    const n = selectedAccount.postsPerDay;
    if (typeof n === "number" && n >= 1 && n <= 40) {
      queueMicrotask(() => setPostCount(n));
    }
  }, [selectedAccount, postCountTouched]);

  const countOptions = Array.from(
    new Set([
      ...BASE_COUNT_OPTIONS,
      ...(selectedAccount && selectedAccount.postsPerDay >= 1
        ? [selectedAccount.postsPerDay]
        : []),
      postCount,
    ])
  )
    .filter((n) => n >= 1 && n <= 40)
    .sort((a, b) => a - b);

  async function handleGenerate() {
    if (!selectedAccountId) return;
    if (checkingClaude) return;
    if (claudeStatus && !claudeStatus.ok) {
      setError(`${claudeStatus.title}\n${claudeStatus.message}\n${claudeStatus.nextAction}`);
      return;
    }

    setGenerating(true);
    setError("");
    setProgress(
      "投稿を生成中…（Opusで1〜3分ほどかかります。このまま閉じずにお待ちください）"
    );

    try {
      const data = await postJSON<{ count: number }>("/api/generate", {
        accountId: selectedAccountId,
        count: postCount,
        extraInstructions: extraInstructions.trim() || undefined,
      });
      setProgress(`${data.count}件の投稿を生成しました`);
      setTimeout(() => onGenerated(), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成に失敗しました");
      setGenerating(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-bold text-gray-800 mb-4">AI投稿生成</h3>

        {/* アカウント選択 */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-600 mb-1">
            アカウント
          </label>
          <select
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
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

        {/* コンセプト未設定の警告 */}
        {selectedAccount && !selectedAccount.conceptSheet && (
          <div className="mb-4 p-3 rounded-lg bg-yellow-50 border border-yellow-200 text-sm text-yellow-700">
            このアカウントのコンセプトシートが未設定です。設定画面から入力してください。
          </div>
        )}

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
            disabled={generating}
            className="w-full px-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
          >
            {countOptions.map((n) => (
              <option key={n} value={n}>
                {n}投稿（{Math.ceil(n / 4)}日分）
                {selectedAccount && n === selectedAccount.postsPerDay
                  ? "（このアカウントの設定本数）"
                  : ""}
              </option>
            ))}
          </select>
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
            placeholder={`例:\n・今回は「退職を伝える勇気が出ない」テーマだけに絞って\n・スレッドの最後にUZUZ無料相談へのCTAを必ず1本入れる\n・○○というキーワードは使わない`}
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

        {/* 進捗表示 */}
        {generating && progress && (
          <div className="mb-4 p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-700 whitespace-pre-wrap leading-relaxed">
            {progress}
          </div>
        )}

        {/* ボタン */}
        <div className="flex gap-3">
          <button
            onClick={handleGenerate}
            disabled={
              generating ||
              checkingClaude ||
              !selectedAccountId ||
              !!(claudeStatus && !claudeStatus.ok)
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
