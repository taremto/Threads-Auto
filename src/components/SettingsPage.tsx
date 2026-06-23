"use client";

import { useState, useEffect, useCallback } from "react";
import { CONCEPT_SHEET_TEMPLATE } from "@/lib/concept-template";
import CloudOffloadWizard from "./CloudOffloadWizard";
import AutoPostingCheckPanel from "./AutoPostingCheckPanel";
import {
  dailyPostCountFromPostingHours,
  normalizeAccountPostingHours,
} from "@/lib/account-posting";

type Account = {
  id: string;
  name: string;
  threadsUserId: string | null;
  threadsUsername: string | null;
  accessToken: string | null;
  postingHours: string;
  postsPerDay: number;
  scheduleJitterMinutes: number;
  conceptSheet: string | null;
  autoGenerate: boolean;
  cloudOffloadEnabled: boolean;
  gasWebAppUrl: string | null;
  gasWebAppKey: string | null;
  gasSpreadsheetId: string | null;
  lastSyncedAt: string | null;
  tokenFingerprint: string | null;
  tokenExpiresAt: string | null;
};

type Knowledge = {
  id: string;
  accountId: string | null;
  type: string;
  title: string;
  content: string;
  isDefault: boolean;
  enabled: boolean;
};

type SettingsTab = "accounts" | "knowledge";

export default function SettingsPage() {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("accounts");

  return (
    <div className="min-w-[720px] flex-1 overflow-y-auto">
      <div className="px-8 pt-6 pb-4">
        <h2 className="text-xl font-bold text-gray-800">システム設定</h2>
        {/* サブタブ */}
        <div className="flex gap-1 mt-3">
          {(
            [
              ["accounts", "アカウント"],
              ["knowledge", "ナレッジ"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSettingsTab(key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                settingsTab === key
                  ? "text-white"
                  : "text-gray-500 hover:bg-gray-100"
              }`}
              style={
                settingsTab === key ? { background: "var(--accent)" } : {}
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div
        className={`px-8 pb-8 ${
          settingsTab === "knowledge" ? "max-w-7xl" : "max-w-3xl"
        }`}
      >
        {settingsTab === "accounts" && <AccountsSection />}
        {settingsTab === "knowledge" && <KnowledgeSection />}
      </div>
    </div>
  );
}

// ===========================================================
// アカウント管理セクション
// ===========================================================
function AccountsSection() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    accessToken: "",
    postingHours: "[6,12,18,21]",
    postsPerDay: 4,
    scheduleJitterMinutes: 15,
    conceptSheet: "",
    autoGenerate: false,
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [pruning, setPruning] = useState(false);
  // コンセプトシートAI編集
  const [conceptAiOpen, setConceptAiOpen] = useState(false);
  const [conceptAiInstruction, setConceptAiInstruction] = useState("");
  const [conceptAiProcessing, setConceptAiProcessing] = useState(false);
  const [conceptAiPreview, setConceptAiPreview] = useState<string | null>(null);
  const [conceptAiError, setConceptAiError] = useState("");

  function resetConceptAi() {
    setConceptAiOpen(false);
    setConceptAiInstruction("");
    setConceptAiProcessing(false);
    setConceptAiPreview(null);
    setConceptAiError("");
  }

  async function handleConceptAiGenerate() {
    if (!editing || !conceptAiInstruction.trim()) return;
    setConceptAiProcessing(true);
    setConceptAiError("");
    setConceptAiPreview(null);
    try {
      const res = await fetch("/api/accounts/concept-ai-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: editing,
          instruction: conceptAiInstruction.trim(),
          currentContent: form.conceptSheet || "",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setConceptAiError(data.error || "AI編集に失敗しました");
      } else {
        setConceptAiPreview(data.content);
      }
    } catch (e) {
      setConceptAiError(e instanceof Error ? e.message : "AI編集に失敗しました");
    } finally {
      setConceptAiProcessing(false);
    }
  }

  function applyConceptAi() {
    if (!conceptAiPreview) return;
    setForm((f) => ({ ...f, conceptSheet: conceptAiPreview }));
    resetConceptAi();
  }

  // 未使用画像の整理（Driveのゴミ掃除）
  async function handlePruneMedia(accountId: string) {
    if (pruning) return;
    if (
      !window.confirm(
        "どの投稿にも使われていない画像を、Googleドライブのゴミ箱へ移動します（30日間は復元可）。実行しますか？"
      )
    ) {
      return;
    }
    setPruning(true);
    setMessage("");
    try {
      const r = await fetch("/api/cloud/prune-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        setMessage(
          `未使用の画像を${d.trashed}枚整理しました（投稿に使っている${d.kept}枚は残しています）。`
        );
      } else {
        setMessage(d.error || `整理に失敗しました (HTTP ${r.status})`);
      }
    } catch (e) {
      setMessage(`整理に失敗しました: ${String(e)}`);
    } finally {
      setPruning(false);
    }
  }

  const fetchAccounts = useCallback(() => {
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (Array.isArray(list)) setAccounts(list);
      })
      .catch(() => {
        /* 通信失敗時は前回の一覧を保持（ポーリング中にチラつかせない） */
      });
  }, []);

  useEffect(() => {
    fetchAccounts();
    // ターミナルでセットアップ（setup-cloud.sh 等）した結果を、開いている画面に自動反映する。
    // タブに戻ってきた時 + 表示中は10秒おきに /api/accounts を取り直す。
    const refresh = () => {
      if (document.visibilityState === "visible") fetchAccounts();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const id = window.setInterval(refresh, 10000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(id);
    };
  }, [fetchAccounts]);

  function startEdit(acc: Account) {
    setEditing(acc.id);
    setForm({
      name: acc.name,
      accessToken: acc.accessToken ? "********" : "",
      postingHours: acc.postingHours,
      postsPerDay: dailyPostCountFromPostingHours(acc.postingHours),
      scheduleJitterMinutes: acc.scheduleJitterMinutes ?? 15,
      conceptSheet: acc.conceptSheet || "",
      autoGenerate: acc.autoGenerate,
    });
    setMessage("");
    resetConceptAi();
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    setMessage("");
    const postingHours = normalizeAccountPostingHours(form.postingHours);

    const data: Record<string, unknown> = {
      name: form.name,
      postingHours: JSON.stringify(postingHours),
      postsPerDay: postingHours.length,
      scheduleJitterMinutes: form.scheduleJitterMinutes,
      conceptSheet: form.conceptSheet || null,
      autoGenerate: form.autoGenerate,
    };
    if (form.accessToken && form.accessToken !== "********") {
      data.accessToken = form.accessToken;
    }

    await fetch("/api/accounts/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editing, ...data }),
    });

    setSaving(false);
    setEditing(null);
    setMessage("保存しました");
    fetchAccounts();
    setTimeout(() => setMessage(""), 2000);
  }

  async function handleDelete(id: string) {
    if (!confirm("このアカウントと全投稿を削除しますか？")) return;
    await fetch(`/api/accounts/delete?id=${id}`, { method: "DELETE" });
    setEditing(null);
    fetchAccounts();
  }

  // 投稿時間帯のパースと表示
  function parseHours(json: string): number[] {
    return normalizeAccountPostingHours(json);
  }

  function toggleHour(hour: number) {
    const hours = parseHours(form.postingHours);
    const idx = hours.indexOf(hour);
    if (idx >= 0) {
      if (hours.length <= 1) {
        setMessage("投稿時間帯は最低1つ必要です");
        setTimeout(() => setMessage(""), 2000);
        return;
      }
      hours.splice(idx, 1);
    } else {
      hours.push(hour);
      hours.sort((a, b) => a - b);
    }
    setForm({
      ...form,
      postingHours: JSON.stringify(hours),
      postsPerDay: hours.length,
    });
  }

  return (
    <section>
      {message && (
        <div className="mb-3 px-4 py-2 rounded-lg bg-green-50 text-green-700 text-sm">
          {message}
        </div>
      )}

      <AutoPostingCheckPanel />

      <div className="space-y-3">
        {accounts.map((acc) => (
          <div
            key={acc.id}
            className="bg-white rounded-xl p-5 shadow-sm border border-gray-100"
          >
            {editing === acc.id ? (
              <div className="space-y-4">
                {/* 基本設定 */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    アカウント名
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    アクセストークン
                  </label>
                  <input
                    type="password"
                    value={form.accessToken}
                    onChange={(e) =>
                      setForm({ ...form, accessToken: e.target.value })
                    }
                    placeholder="Threads API のアクセストークン"
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
                  />
                </div>

                {/* 投稿スケジュール */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-2">
                    投稿時間帯
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {Array.from({ length: 24 }, (_, i) => i).map((h) => {
                      const selected = parseHours(form.postingHours).includes(h);
                      return (
                        <button
                          key={h}
                          onClick={() => toggleHour(h)}
                          className={`w-10 h-8 rounded text-xs font-mono transition-colors ${
                            selected
                              ? "text-white"
                              : "text-gray-400 bg-gray-50 hover:bg-gray-100"
                          }`}
                          style={
                            selected ? { background: "var(--accent)" } : {}
                          }
                        >
                          {h}時
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    1日の投稿数
                  </label>
                  <div className="inline-flex items-center px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-700">
                    {parseHours(form.postingHours).length}投稿/日
                  </div>
                  <p className="mt-1 text-[11px] text-gray-400">
                    投稿時間帯の数で自動決定します。例: 6時/12時/18時/21時なら4投稿/日です。
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    予約時間のランダム幅
                  </label>
                  <select
                    value={form.scheduleJitterMinutes}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        scheduleJitterMinutes: Number(e.target.value),
                      })
                    }
                    className="px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
                  >
                    {[0, 5, 10, 15, 20, 30].map((n) => (
                      <option key={n} value={n}>
                        {n === 0 ? "ランダムなし" : `0〜${n}分ランダム`}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-gray-400">
                    一括予約時に、選んだ投稿時間から少しだけ後ろへずらします。初期値は0〜15分です。
                  </p>
                </div>

                {/* 自動生成ON/OFF */}
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.autoGenerate}
                      onChange={(e) =>
                        setForm({ ...form, autoGenerate: e.target.checked })
                      }
                      className="w-4 h-4 rounded"
                    />
                    <span className="text-sm text-gray-700">
                      毎朝5時に自動生成する
                    </span>
                  </label>
                </div>

                {/* クラウドオフロード（PCを閉じても投稿） */}
                <CloudOffloadWizard account={acc} onChange={fetchAccounts} />

                {/* 未使用画像の整理（Driveのゴミ掃除） */}
                {acc.cloudOffloadEnabled && (
                  <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => handlePruneMedia(acc.id)}
                      disabled={pruning}
                      className="text-xs font-medium text-gray-600 hover:text-gray-800 hover:underline disabled:opacity-50"
                    >
                      🧹 {pruning ? "整理中…" : "未使用の画像を整理（Driveを掃除）"}
                    </button>
                    <p className="mt-1 text-[11px] text-gray-400">
                      どの投稿にも使っていない画像を、Googleドライブの ThreadsAutoMedia
                      フォルダからゴミ箱へ移します（30日間は復元可）。投稿に使っている画像は残ります。
                    </p>
                  </div>
                )}

                {/* コンセプトシート */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-gray-500">
                      コンセプトシート
                    </label>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setConceptAiOpen(!conceptAiOpen)}
                        disabled={conceptAiProcessing}
                        className="text-[11px] text-purple-600 hover:underline disabled:opacity-50"
                      >
                        🤖 AIで編集
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const cur = form.conceptSheet || "";
                          if (
                            cur.trim().length > 0 &&
                            !window.confirm("既存の内容をテンプレで上書きしますか？")
                          ) {
                            return;
                          }
                          setForm({ ...form, conceptSheet: CONCEPT_SHEET_TEMPLATE });
                        }}
                        className="text-[11px] text-blue-600 hover:underline"
                      >
                        💡 記入テンプレを挿入
                      </button>
                    </div>
                  </div>

                  {/* コンセプトAI編集パネル */}
                  {conceptAiOpen && (
                    <div className="mb-2 p-3 rounded-lg border border-purple-200 bg-purple-50">
                      <p className="text-xs font-medium text-purple-700 mb-2">
                        🤖 AIにコンセプトシートを編集してもらう
                      </p>
                      <textarea
                        value={conceptAiInstruction}
                        onChange={(e) => setConceptAiInstruction(e.target.value)}
                        disabled={conceptAiProcessing}
                        rows={2}
                        placeholder="例: ターゲットを20代後半の女性に絞って書き直して / 避けたい定型表現の項目を追加して"
                        className="w-full px-3 py-2 rounded-lg border border-purple-300 text-sm focus:outline-none focus:border-purple-500 bg-white disabled:opacity-50"
                      />
                      {conceptAiError && (
                        <p className="text-xs text-red-600 mt-1">{conceptAiError}</p>
                      )}
                      {conceptAiProcessing && (
                        <p className="text-xs text-purple-600 mt-2">
                          AIが編集案を作成中です…（少し時間がかかります）
                        </p>
                      )}
                      {conceptAiPreview && (
                        <div className="mt-2">
                          <p className="text-xs text-purple-600 mb-1">編集案のプレビュー：</p>
                          <div className="text-sm whitespace-pre-wrap text-gray-800 bg-white p-3 rounded-lg border border-purple-200 max-h-60 overflow-y-auto leading-relaxed">
                            {conceptAiPreview}
                          </div>
                        </div>
                      )}
                      <div className="flex gap-2 mt-2">
                        {!conceptAiPreview ? (
                          <button
                            type="button"
                            onClick={handleConceptAiGenerate}
                            disabled={
                              conceptAiProcessing || !conceptAiInstruction.trim()
                            }
                            className="px-3 py-1.5 rounded-md text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
                            style={{ background: "#7b1fa2" }}
                          >
                            {conceptAiProcessing ? "処理中..." : "AIで編集"}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={applyConceptAi}
                              className="px-3 py-1.5 rounded-md text-xs font-medium text-white transition-opacity hover:opacity-80"
                              style={{ background: "#7b1fa2" }}
                            >
                              この内容を反映
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setConceptAiPreview(null);
                                setConceptAiError("");
                              }}
                              className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-700 bg-gray-200 transition-opacity hover:opacity-80"
                            >
                              やり直す
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={resetConceptAi}
                          disabled={conceptAiProcessing}
                          className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                        >
                          閉じる
                        </button>
                      </div>
                    </div>
                  )}
                  <textarea
                    value={form.conceptSheet}
                    onChange={(e) =>
                      setForm({ ...form, conceptSheet: e.target.value })
                    }
                    placeholder="ペルソナ定義、ターゲット、独自性、避けたい定型表現等を入力。「💡記入テンプレを挿入」ボタンで質問形式のテンプレを呼び出せます。"
                    rows={14}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300 font-mono"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    AI生成の精度はこのコンセプトシートの記入精度で決まります。失敗体験・持論・避けたい定型句を埋めるほど刺さるフックが生まれます。
                  </p>
                </div>

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                    style={{ background: "var(--accent)" }}
                  >
                    {saving ? "保存中..." : "保存"}
                  </button>
                  <button
                    onClick={() => setEditing(null)}
                    className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100"
                  >
                    キャンセル
                  </button>
                  <div className="flex-1" />
                  <button
                    onClick={() => handleDelete(acc.id)}
                    className="px-4 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50"
                  >
                    削除
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-bold text-gray-800">{acc.name}</span>
                  {acc.threadsUsername && (
                    <span className="ml-2 text-xs text-gray-400">
                      @{acc.threadsUsername}
                    </span>
                  )}
                  <div className="flex gap-3 text-xs text-gray-400 mt-1">
                    {acc.accessToken ? (
                      <span className="text-green-500">トークン設定済み</span>
                    ) : (
                      <span className="text-orange-400">トークン未設定</span>
                    )}
                    <span>
                      {parseHours(acc.postingHours)
                        .map((h: number) => `${h}時`)
                        .join("/")}
                    </span>
                    <span>
                      {dailyPostCountFromPostingHours(acc.postingHours)}投稿/日
                    </span>
                    {acc.autoGenerate && (
                      <span className="text-blue-500">自動生成ON</span>
                    )}
                    {acc.cloudOffloadEnabled && (
                      <span className="text-green-600">☁ クラウドオフロードON</span>
                    )}
                    {acc.conceptSheet ? (
                      <span className="text-green-500">
                        コンセプト設定済み
                      </span>
                    ) : (
                      <span className="text-orange-400">
                        コンセプト未設定
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => startEdit(acc)}
                  className="px-4 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100"
                >
                  編集
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ===========================================================
// ナレッジ管理セクション
// ===========================================================
function KnowledgeSection() {
  const [knowledges, setKnowledges] = useState<Knowledge[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // フィルタ: "all"=全件 / "common"=共通のみ / accountId=そのアカウント固有のみ
  const [filter, setFilter] = useState<string>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    title: "",
    type: "custom" as string,
    content: "",
    accountId: null as string | null,
  });
  const [saving, setSaving] = useState(false);
  // AI編集
  const [aiEditingId, setAiEditingId] = useState<string | null>(null);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiProcessing, setAiProcessing] = useState(false);
  const [aiPreview, setAiPreview] = useState<string | null>(null);
  const [aiError, setAiError] = useState("");
  // 右側の全文プレビューで表示するナレッジ
  const [selectedId, setSelectedId] = useState<string | null>(null);

  function resetAiEdit() {
    setAiEditingId(null);
    setAiInstruction("");
    setAiProcessing(false);
    setAiPreview(null);
    setAiError("");
  }

  async function handleToggleEnabled(id: string, enabled: boolean) {
    await fetch("/api/knowledge", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    fetchKnowledges();
  }

  async function handleAiGenerate() {
    if (!aiEditingId || !aiInstruction.trim()) return;
    setAiProcessing(true);
    setAiError("");
    setAiPreview(null);
    try {
      const res = await fetch("/api/knowledge/ai-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          knowledgeId: aiEditingId,
          instruction: aiInstruction.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiError(data.error || "AI編集に失敗しました");
      } else {
        setAiPreview(data.content);
      }
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI編集に失敗しました");
    } finally {
      setAiProcessing(false);
    }
  }

  async function handleAiApply() {
    if (!aiEditingId || !aiPreview) return;
    await fetch("/api/knowledge", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: aiEditingId, content: aiPreview }),
    });
    resetAiEdit();
    fetchKnowledges();
  }

  const fetchKnowledges = useCallback(() => {
    fetch("/api/knowledge?scope=all")
      .then((r) => (r.ok ? r.json() : []))
      .then(setKnowledges)
      .catch(() => setKnowledges([]));
  }, []);

  const fetchAccounts = useCallback(() => {
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    fetchKnowledges();
    fetchAccounts();
  }, [fetchKnowledges, fetchAccounts]);

  function accountName(accountId: string | null): string {
    if (!accountId) return "全アカウント共通";
    const acc = accounts.find((a) => a.id === accountId);
    return acc ? acc.name : "（不明なアカウント）";
  }

  function startEdit(k: Knowledge) {
    setEditing(k.id);
    setCreating(false);
    setForm({
      title: k.title,
      type: k.type,
      content: k.content,
      accountId: k.accountId,
    });
  }

  function startCreate() {
    setCreating(true);
    setEditing(null);
    // フィルタが特定アカウントなら、新規作成時もそのアカウントを初期値に
    const initialAccountId =
      filter !== "all" && filter !== "common" ? filter : null;
    setForm({
      title: "",
      type: "custom",
      content: "",
      accountId: initialAccountId,
    });
  }

  const filtered = knowledges.filter((k) => {
    if (filter === "all") return true;
    if (filter === "common") return k.accountId === null;
    return k.accountId === filter;
  });

  async function handleSave() {
    setSaving(true);

    if (creating) {
      await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    } else if (editing) {
      await fetch("/api/knowledge", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editing, ...form }),
      });
    }

    setSaving(false);
    setEditing(null);
    setCreating(false);
    fetchKnowledges();
  }

  async function handleDelete(id: string) {
    if (!confirm("このナレッジを削除しますか？")) return;
    await fetch(`/api/knowledge?id=${id}`, { method: "DELETE" });
    setEditing(null);
    fetchKnowledges();
  }

  const typeLabels: Record<string, string> = {
    rules: "生成ルール",
    structures: "構成パターン",
    custom: "追加ナレッジ",
  };

  // 右側の全文プレビュー欄に出す内容を決める
  const selectedKnowledge = knowledges.find((k) => k.id === selectedId) || null;
  const previewContent =
    aiPreview ??
    (creating || editing ? form.content : selectedKnowledge?.content ?? "");
  const previewTitle = creating
    ? form.title || "新規ナレッジ"
    : editing
      ? form.title || "編集中のナレッジ"
      : selectedKnowledge?.title || "全文プレビュー";
  const previewBadge = aiPreview
    ? "AIプレビュー"
    : creating
      ? "新規作成中"
      : editing
        ? "編集中"
        : selectedKnowledge
          ? "選択中"
          : undefined;

  return (
    <section>
      <div className="flex items-start justify-between mb-3 gap-3">
        <p className="text-sm text-gray-500 flex-1">
          投稿生成に使うナレッジを管理します。「全アカウント共通」のナレッジは全てのアカウントで使われ、特定アカウントを指定したナレッジはそのアカウントの生成時のみ追加で使われます。
        </p>
        <button
          onClick={startCreate}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white whitespace-nowrap"
          style={{ background: "var(--accent)" }}
        >
          + ナレッジ追加
        </button>
      </div>

      <div className="mb-4 p-3 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-500 leading-relaxed">
        💡 ここで追加・編集・削除したナレッジは、このアプリ（中の小さなデータベース）に保存されます。
        ツールに最初から入っている <code>prisma/</code> フォルダ内の <code>.md</code> ファイルは
        「初回セットアップ用の初期テンプレート」で、ここでの編集では書き換わりません（編集が消えるわけではなく、アプリ側に保存されています）。
      </div>

      {/* フィルタ */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="text-xs text-gray-500">対象:</span>
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          すべて ({knowledges.length})
        </FilterChip>
        <FilterChip
          active={filter === "common"}
          onClick={() => setFilter("common")}
        >
          全アカウント共通 ({knowledges.filter((k) => !k.accountId).length})
        </FilterChip>
        {accounts.map((a) => {
          const count = knowledges.filter((k) => k.accountId === a.id).length;
          return (
            <FilterChip
              key={a.id}
              active={filter === a.id}
              onClick={() => setFilter(a.id)}
            >
              {a.name} ({count})
            </FilterChip>
          );
        })}
      </div>

      {/* 新規作成フォーム */}
      {creating && (
        <div className="bg-white rounded-xl p-5 shadow-sm border border-blue-200 mb-3">
          <KnowledgeForm
            form={form}
            setForm={setForm}
            accounts={accounts}
            onSave={handleSave}
            onCancel={() => setCreating(false)}
            saving={saving}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.82fr)] gap-4 items-start">
      <div className="space-y-3 min-w-0">
        {filtered.map((k) => (
          <div
            key={k.id}
            onClick={() => setSelectedId(k.id)}
            className={`bg-white rounded-xl p-5 shadow-sm border cursor-pointer transition-colors ${
              selectedId === k.id ? "border-blue-300" : "border-gray-100"
            } ${k.enabled === false ? "opacity-50" : ""}`}
          >
            {editing === k.id ? (
              <div>
                <KnowledgeForm
                  form={form}
                  setForm={setForm}
                  accounts={accounts}
                  onSave={handleSave}
                  onCancel={() => setEditing(null)}
                  saving={saving}
                />
                {!k.isDefault && (
                  <button
                    onClick={() => handleDelete(k.id)}
                    className="mt-2 px-4 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50"
                  >
                    削除
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-bold text-gray-800">{k.title}</span>
                  <span className="ml-2 px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500">
                    {typeLabels[k.type] || k.type}
                  </span>
                  <span
                    className={`ml-1 px-2 py-0.5 rounded text-xs ${
                      k.accountId
                        ? "bg-purple-50 text-purple-600"
                        : "bg-emerald-50 text-emerald-600"
                    }`}
                  >
                    {accountName(k.accountId)}
                  </span>
                  {k.isDefault && (
                    <span className="ml-1 px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-500">
                      デフォルト
                    </span>
                  )}
                  {k.enabled === false && (
                    <span className="ml-1 px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-400">
                      生成で未使用
                    </span>
                  )}
                  <p className="text-xs text-gray-400 mt-1">
                    {k.content.slice(0, 100)}...
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* ON/OFFトグル */}
                  <button
                    onClick={() => handleToggleEnabled(k.id, !(k.enabled !== false))}
                    title={
                      k.enabled !== false
                        ? "生成に使用中（クリックでOFF）"
                        : "生成で未使用（クリックでON）"
                    }
                    className={`relative w-10 h-5 rounded-full transition-colors ${
                      k.enabled !== false ? "bg-green-400" : "bg-gray-300"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        k.enabled !== false ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                  <button
                    onClick={() => {
                      resetAiEdit();
                      setAiEditingId(k.id);
                    }}
                    disabled={aiEditingId === k.id}
                    className="px-3 py-1.5 rounded-lg text-sm text-purple-600 hover:bg-purple-50 disabled:opacity-50"
                  >
                    AI編集
                  </button>
                  <button
                    onClick={() => startEdit(k)}
                    className="px-4 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100"
                  >
                    編集
                  </button>
                </div>
              </div>
            )}

            {/* ナレッジAI編集パネル */}
            {aiEditingId === k.id && editing !== k.id && (
              <div className="mt-3 p-3 rounded-lg border border-purple-200 bg-purple-50">
                <span className="text-sm font-medium text-purple-700">
                  🤖 AI編集
                </span>
                <textarea
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  disabled={aiProcessing}
                  rows={2}
                  placeholder="例: もっと具体例を増やして / 重複している項目を整理して / 禁止表現を3つ追加して"
                  className="mt-2 w-full px-3 py-2 rounded-lg border border-purple-300 text-sm focus:outline-none focus:border-purple-500 bg-white disabled:opacity-50"
                />
                {aiError && <p className="text-xs text-red-600 mt-1">{aiError}</p>}
                {aiProcessing && (
                  <p className="text-xs text-purple-600 mt-2">
                    AIが編集案を作成中です…（少し時間がかかります）
                  </p>
                )}
                {aiPreview && (
                  <div className="mt-2">
                    <p className="text-xs text-purple-600 mb-1">編集案のプレビュー：</p>
                    <div className="text-sm whitespace-pre-wrap text-gray-800 bg-white p-3 rounded-lg border border-purple-200 max-h-60 overflow-y-auto leading-relaxed">
                      {aiPreview}
                    </div>
                  </div>
                )}
                <div className="flex gap-2 mt-2">
                  {!aiPreview ? (
                    <button
                      onClick={handleAiGenerate}
                      disabled={aiProcessing || !aiInstruction.trim()}
                      className="px-3 py-1.5 rounded-md text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
                      style={{ background: "#7b1fa2" }}
                    >
                      {aiProcessing ? "処理中..." : "AIで編集"}
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={handleAiApply}
                        className="px-3 py-1.5 rounded-md text-xs font-medium text-white transition-opacity hover:opacity-80"
                        style={{ background: "#7b1fa2" }}
                      >
                        この内容で保存
                      </button>
                      <button
                        onClick={() => {
                          setAiPreview(null);
                          setAiError("");
                        }}
                        className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-700 bg-gray-200 transition-opacity hover:opacity-80"
                      >
                        やり直す
                      </button>
                    </>
                  )}
                  <button
                    onClick={resetAiEdit}
                    disabled={aiProcessing}
                    className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                  >
                    閉じる
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {filtered.length === 0 && !creating && (
          <div className="text-center py-10 text-gray-400 text-sm">
            {knowledges.length === 0
              ? "ナレッジがまだありません。「+ ナレッジ追加」またはデフォルトナレッジをシードしてください。"
              : "このフィルタに該当するナレッジはありません。"}
          </div>
        )}
      </div>

      {/* 右側：全文プレビュー欄（大画面のみ・追従表示） */}
      <div className="hidden lg:block">
        <ContentPreviewPanel
          title={previewTitle}
          content={previewContent}
          badge={previewBadge}
          emptyText="左のナレッジをクリックすると、ここに全文が表示されます。"
        />
      </div>
      </div>
    </section>
  );
}

function ContentPreviewPanel({
  title,
  content,
  badge,
  emptyText,
}: {
  title: string;
  content: string;
  badge?: string;
  emptyText: string;
}) {
  const hasContent = content.trim().length > 0;
  return (
    <aside className="lg:sticky lg:top-6 self-start min-w-0">
      <div
        className="flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden"
        style={{ height: "calc(100vh - 170px)", minHeight: "480px" }}
      >
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-start justify-between gap-3">
          <h3 className="text-sm font-bold text-gray-800 truncate min-w-0">
            {title}
          </h3>
          {badge && (
            <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">
              {badge}
            </span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {hasContent ? (
            <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800 font-sans">
              {content}
            </pre>
          ) : (
            <p className="text-sm text-gray-400">{emptyText}</p>
          )}
        </div>
        {hasContent && (
          <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 text-[11px] text-gray-400">
            {content.length} 文字
          </div>
        )}
      </div>
    </aside>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
        active
          ? "text-white"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
      }`}
      style={active ? { background: "var(--accent)" } : {}}
    >
      {children}
    </button>
  );
}

function KnowledgeForm({
  form,
  setForm,
  accounts,
  onSave,
  onCancel,
  saving,
}: {
  form: { title: string; type: string; content: string; accountId: string | null };
  setForm: (f: { title: string; type: string; content: string; accountId: string | null }) => void;
  accounts: Account[];
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          タイトル
        </label>
        <input
          type="text"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="例: 投稿の口調ルール"
          className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          対象アカウント
        </label>
        <select
          value={form.accountId ?? ""}
          onChange={(e) =>
            setForm({ ...form, accountId: e.target.value || null })
          }
          className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300"
        >
          <option value="">全アカウント共通</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} のみ
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-400 mt-1">
          特定のアカウントだけに反映したい内容がある場合は、そのアカウントを選んでください。迷ったら「全アカウント共通」のままでOKです。
        </p>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          内容
        </label>
        <textarea
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          rows={15}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300 font-mono"
          placeholder="ナレッジの内容を入力..."
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={onSave}
          disabled={saving || !form.title || !form.content}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {saving ? "保存中..." : "保存"}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100"
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}
