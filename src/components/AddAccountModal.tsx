"use client";

import { useRef, useState } from "react";
import { getJSON, postJSON } from "@/lib/api";

type Props = {
  onClose: () => void;
  onCreated: (accountId: string) => void;
};

type Step = "input" | "verifying" | "verified" | "saving";

export default function AddAccountModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [verified, setVerified] = useState<{
    userId: string;
    username: string;
  } | null>(null);
  const [dupWarning, setDupWarning] = useState<string | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // 接続テスト中の通信を中断して入力画面に戻す
  function cancelVerifying() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStep("input");
  }

  async function handleVerify() {
    if (!name.trim()) {
      setError("アカウント名を入力してください");
      return;
    }
    if (!token.trim()) {
      setError("アクセストークンを入力してください");
      return;
    }

    setError("");
    setStep("verifying");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = await postJSON<{
        ok?: boolean;
        userId?: string;
        username?: string;
        error?: string;
      }>(
        "/api/threads/verify",
        { accessToken: token.trim() },
        { signal: controller.signal }
      );

      if (!data.ok || !data.userId) {
        setError(data.error || "接続に失敗しました");
        setStep("input");
        return;
      }

      setVerified({ userId: data.userId, username: data.username || "" });

      // 同じThreadsアカウント（threadsUserId）が既に登録されていないか確認
      setDupWarning(null);
      try {
        const accounts = await getJSON<
          { name: string; threadsUserId: string | null }[]
        >("/api/accounts", { signal: controller.signal });
        const dup = Array.isArray(accounts)
          ? accounts.find(
              (a) => a.threadsUserId && a.threadsUserId === data.userId
            )
          : null;
        if (dup) {
          setDupWarning(
            `このThreadsアカウント（@${data.username}）は、すでに「${dup.name}」として登録されています。同じアカウントを2つ登録すると、投稿・コンセプト・キューが混ざって見えます。別のThreadsアカウントを連携したい場合は、いったんログアウトして対象アカウントのトークンを取得し直してください。`
          );
        }
      } catch {
        // 重複チェックは失敗しても無視（致命的ではない）
      }
      setStep("verified");
    } catch (e) {
      if (controller.signal.aborted) return; // ユーザーがキャンセル
      setError(e instanceof Error ? e.message : "接続に失敗しました");
      setStep("input");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  async function handleSave() {
    if (!verified) return;
    setStep("saving");
    try {
      const account = await postJSON<{ id: string }>("/api/accounts", {
        name: name.trim(),
        accessToken: token.trim(),
        threadsUserId: verified.userId,
        threadsUsername: verified.username,
      });
      onCreated(account.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "アカウントの作成に失敗しました");
      setStep("verified");
    }
  }

  function handleSkipToken() {
    if (step === "verifying") cancelVerifying();
    if (!name.trim()) {
      setError("アカウント名を入力してください");
      return;
    }
    handleSaveWithoutToken();
  }

  async function handleSaveWithoutToken() {
    setStep("saving");
    try {
      const account = await postJSON<{ id: string }>("/api/accounts", {
        name: name.trim(),
      });
      onCreated(account.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "アカウントの作成に失敗しました");
      setStep("input");
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-[420px] max-h-[90vh] overflow-y-auto shadow-xl">
        <h3 className="text-lg font-bold mb-1">アカウント追加</h3>
        <p className="text-xs text-gray-400 mb-5">
          Threadsアカウントを接続して投稿管理を始めましょう
        </p>

        {/* Step: input / verifying */}
        {(step === "input" || step === "verifying") && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                アカウント名
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: 美容アカウント"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
                autoFocus
                disabled={step === "verifying"}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                アクセストークン
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Threads API のアクセストークン"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
                disabled={step === "verifying"}
              />
            </div>

            {error && (
              <div className="px-3 py-2 rounded-lg bg-red-50 text-red-600 text-xs">
                {error}
              </div>
            )}

            {step === "verifying" && (
              <div className="px-3 py-2 rounded-lg bg-blue-50 text-blue-600 text-xs">
                接続テスト中... 反応がない場合は「キャンセル」で中断できます。
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={handleVerify}
                disabled={step === "verifying"}
                className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--accent)" }}
              >
                {step === "verifying" ? "接続テスト中..." : "接続テスト"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (step === "verifying") cancelVerifying();
                  else onClose();
                }}
                className="px-4 py-2.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100"
              >
                キャンセル
              </button>
            </div>

            <button
              onClick={handleSkipToken}
              className="w-full text-xs text-gray-400 hover:text-gray-600 pt-1"
            >
              トークンなしで作成（あとで設定できます）
            </button>
          </div>
        )}

        {/* Step: verified */}
        {step === "verified" && verified && (
          <div className="space-y-4">
            <div className="px-4 py-3 rounded-lg bg-green-50 border border-green-100">
              <p className="text-sm font-medium text-green-700 mb-1">
                接続成功
              </p>
              <p className="text-xs text-green-600">
                @{verified.username}（ID: {verified.userId}）
              </p>
            </div>

            {dupWarning && (
              <div className="px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 leading-relaxed">
                ⚠️ {dupWarning}
              </div>
            )}

            {error && (
              <div className="px-3 py-2 rounded-lg bg-red-50 text-red-600 text-xs">
                {error}
              </div>
            )}

            <div className="text-sm text-gray-600">
              <span className="font-medium">{name}</span> として追加します
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleSave}
                className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-white"
                style={{ background: "#4caf50" }}
              >
                追加する
              </button>
              <button
                onClick={() => {
                  setStep("input");
                  setVerified(null);
                  setDupWarning(null);
                  setError("");
                }}
                className="px-4 py-2.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100"
              >
                戻る
              </button>
            </div>
          </div>
        )}

        {/* Step: saving */}
        {step === "saving" && (
          <div className="py-8 text-center">
            <p className="text-sm text-gray-500">アカウントを作成中...</p>
          </div>
        )}
      </div>
    </div>
  );
}
