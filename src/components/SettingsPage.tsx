"use client";

import { useState, useEffect, useCallback } from "react";
import { CONCEPT_SHEET_TEMPLATE } from "@/lib/concept-template";
import { PERSONA_SHEET_TEMPLATE } from "@/lib/persona-template";
import CloudOffloadWizard from "./CloudOffloadWizard";
import AutoPostingCheckPanel from "./AutoPostingCheckPanel";
import {
  dailyPostCountFromPostingHours,
  normalizeAccountPostingHours,
} from "@/lib/account-posting";
import {
  findKnowledgeMapping,
} from "@/lib/knowledge-metadata";
import { STEP_DEFINITIONS } from "@/lib/generation-steps";

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
  personaSheet: string | null;
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

type KnowledgeSyncResult = {
  ok: boolean;
  mode: "preview" | "applied";
  scanned: number;
  updated: number;
  created: number;
  unchanged: number;
  skipped: number;
  updates: Array<{
    id: string;
    title: string;
    relativePath: string;
    titleChanged: boolean;
    contentChanged: boolean;
  }>;
  creations: Array<{
    id: string | null;
    title: string;
    relativePath: string;
  }>;
};

type SettingsTab = "accounts" | "knowledge" | "specialty";
type SettingsMode = "accounts" | "knowledge";

const SPECIALTY_TITLE_PREFIX = "専門ナレッジ";

function isSpecialtyKnowledge(knowledge: Knowledge): boolean {
  return (
    knowledge.type === "custom" &&
    knowledge.title.startsWith(SPECIALTY_TITLE_PREFIX)
  );
}

function normalizeSpecialtyTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.startsWith(SPECIALTY_TITLE_PREFIX)) return trimmed;
  return `${SPECIALTY_TITLE_PREFIX} ${trimmed}`.trim();
}

export default function SettingsPage({
  mode = "accounts",
}: {
  mode?: SettingsMode;
}) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(
    mode === "knowledge" ? "knowledge" : "accounts"
  );
  const availableTabs: Array<[SettingsTab, string]> =
    mode === "knowledge"
      ? [
          ["knowledge", "ナレッジ"],
          ["specialty", "専門ナレッジ"],
        ]
      : [["accounts", "アカウント設定"]];

  return (
    <div className="min-w-[720px] flex-1 overflow-y-auto">
      <div className="px-8 pt-6 pb-4">
        <h2 className="text-xl font-bold text-gray-800">
          {mode === "knowledge" ? "ナレッジ" : "アカウント設定"}
        </h2>
        {/* サブタブ */}
        {availableTabs.length > 1 && (
          <div className="flex gap-1 mt-3">
            {availableTabs.map(([key, label]) => (
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
        )}
      </div>

      <div
        className={`px-8 pb-8 ${
          settingsTab === "knowledge" || settingsTab === "specialty"
            ? "max-w-7xl"
            : "max-w-3xl"
        }`}
      >
        {settingsTab === "accounts" && <AccountsSection />}
        {settingsTab === "knowledge" && <KnowledgeSection />}
        {settingsTab === "specialty" && <KnowledgeSection specialty />}
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
    personaSheet: "",
    autoGenerate: false,
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [pruning, setPruning] = useState(false);
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
      personaSheet: acc.personaSheet || "",
      autoGenerate: acc.autoGenerate,
    });
    setMessage("");
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
      personaSheet: form.personaSheet || null,
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

                <AccountSheetField
                  key={`${acc.id}-concept`}
                  accountId={acc.id}
                  sheetType="concept"
                  label="アカウントコンセプト"
                  value={form.conceptSheet}
                  onChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      conceptSheet: value,
                    }))
                  }
                  template={CONCEPT_SHEET_TEMPLATE}
                  rows={14}
                  placeholder="発信者、テーマ、提供価値、独自性、トーン、避けたい表現等を入力できます。"
                  description="誰が・何を・どんな価値と口調で発信するアカウントかを定義します。"
                />

                <AccountSheetField
                  key={`${acc.id}-persona`}
                  accountId={acc.id}
                  sheetType="persona"
                  label="ペルソナ設計"
                  value={form.personaSheet}
                  onChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      personaSheet: value,
                    }))
                  }
                  template={PERSONA_SHEET_TEMPLATE}
                  rows={14}
                  placeholder="投稿を届けたい読者の状況、悩み、感情、反論、望む未来を具体的に入力できます。"
                  description="投稿ごとに切り取る読者の場面・悩み・言葉を決めるために使います。未入力でも従来どおり生成できます。"
                />

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
                    {acc.personaSheet ? (
                      <span className="text-green-500">
                        ペルソナ設定済み
                      </span>
                    ) : (
                      <span className="text-orange-400">
                        ペルソナ未設定
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

type AccountSheetFieldProps = {
  accountId: string;
  sheetType: "concept" | "persona";
  label: string;
  value: string;
  onChange: (value: string) => void;
  template: string;
  rows: number;
  placeholder: string;
  description: string;
};

function AccountSheetField({
  accountId,
  sheetType,
  label,
  value,
  onChange,
  template,
  rows,
  placeholder,
  description,
}: AccountSheetFieldProps) {
  const [aiOpen, setAiOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [processing, setProcessing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");

  function resetAi() {
    setAiOpen(false);
    setInstruction("");
    setProcessing(false);
    setPreview(null);
    setError("");
  }

  async function handleAiGenerate() {
    if (!instruction.trim()) return;
    setProcessing(true);
    setError("");
    setPreview(null);
    try {
      const res = await fetch("/api/accounts/concept-ai-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          sheetType,
          instruction: instruction.trim(),
          currentContent: value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "AI編集に失敗しました");
      } else {
        setPreview(data.content);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI編集に失敗しました");
    } finally {
      setProcessing(false);
    }
  }

  function insertTemplate() {
    if (
      value.trim().length > 0 &&
      !window.confirm("既存の内容をテンプレで上書きしますか？")
    ) {
      return;
    }
    onChange(template);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-xs font-medium text-gray-500">
          {label}
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setAiOpen(!aiOpen)}
            disabled={processing}
            className="text-[11px] text-purple-600 hover:underline disabled:opacity-50"
          >
            🤖 AIで編集
          </button>
          <button
            type="button"
            onClick={insertTemplate}
            className="text-[11px] text-blue-600 hover:underline"
          >
            💡 記入テンプレを挿入
          </button>
        </div>
      </div>

      {aiOpen && (
        <div className="mb-2 p-3 rounded-lg border border-purple-200 bg-purple-50">
          <p className="text-xs font-medium text-purple-700 mb-2">
            🤖 AIに{label}を編集してもらう
          </p>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={processing}
            rows={2}
            placeholder={
              sheetType === "persona"
                ? "例: 20代の短期離職経験者に絞り、平日の場面と本人が使う言葉を具体化して"
                : "例: 発信テーマを転職と職場の人間関係に絞り、トーンと避けたい表現を整理して"
            }
            className="w-full px-3 py-2 rounded-lg border border-purple-300 text-sm focus:outline-none focus:border-purple-500 bg-white disabled:opacity-50"
          />
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
          {processing && (
            <p className="text-xs text-purple-600 mt-2">
              AIが編集案を作成中です…（少し時間がかかります）
            </p>
          )}
          {preview && (
            <div className="mt-2">
              <p className="text-xs text-purple-600 mb-1">
                編集案のプレビュー：
              </p>
              <div className="text-sm whitespace-pre-wrap text-gray-800 bg-white p-3 rounded-lg border border-purple-200 max-h-60 overflow-y-auto leading-relaxed">
                {preview}
              </div>
            </div>
          )}
          <div className="flex gap-2 mt-2">
            {!preview ? (
              <button
                type="button"
                onClick={handleAiGenerate}
                disabled={processing || !instruction.trim()}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ background: "#7b1fa2" }}
              >
                {processing ? "処理中..." : "AIで編集"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onChange(preview);
                    resetAi();
                  }}
                  className="px-3 py-1.5 rounded-md text-xs font-medium text-white transition-opacity hover:opacity-80"
                  style={{ background: "#7b1fa2" }}
                >
                  この内容を反映
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreview(null);
                    setError("");
                  }}
                  className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-700 bg-gray-200 transition-opacity hover:opacity-80"
                >
                  やり直す
                </button>
              </>
            )}
            <button
              type="button"
              onClick={resetAi}
              disabled={processing}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-blue-300 font-mono"
      />
      <p className="text-[11px] text-gray-400 mt-1">{description}</p>
    </div>
  );
}

// ===========================================================
// ナレッジ管理セクション
// ===========================================================
function KnowledgeSection({ specialty = false }: { specialty?: boolean }) {
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
  // ビュー: 投稿生成フロー順 or フラット
  const [viewMode, setViewMode] = useState<"flat" | "flow">("flow");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncError, setSyncError] = useState("");
  const [pendingSync, setPendingSync] = useState<KnowledgeSyncResult | null>(
    null
  );

  function resetAiEdit() {
    setAiEditingId(null);
    setAiInstruction("");
    setAiProcessing(false);
    setAiPreview(null);
    setAiError("");
  }

  async function handleKnowledgeSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncMessage("");
    setSyncError("");
    setPendingSync(null);

    try {
      const previewResponse = await fetch("/api/knowledge/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: false }),
      });
      const preview = (await previewResponse.json()) as
        | KnowledgeSyncResult
        | { error?: string };
      if (!previewResponse.ok || !("updated" in preview)) {
        throw new Error(
          "error" in preview && preview.error
            ? preview.error
            : "更新対象を確認できませんでした"
        );
      }

      if (preview.updated === 0 && preview.created === 0) {
        setSyncMessage(
          `外部ファイルは最新です（${preview.scanned}件確認、DB連携対象外 ${preview.skipped}件）`
        );
        return;
      }

      setPendingSync(preview);
    } catch (error) {
      setSyncError(
        error instanceof Error
          ? error.message
          : "ナレッジの更新に失敗しました"
      );
    } finally {
      setSyncing(false);
    }
  }

  async function applyKnowledgeSync() {
    if (!pendingSync || syncing) return;
    setSyncing(true);
    setSyncError("");
    setSyncMessage("");
    try {
      const applyResponse = await fetch("/api/knowledge/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      const applied = (await applyResponse.json()) as
        | KnowledgeSyncResult
        | { error?: string };
      if (!applyResponse.ok || !("updated" in applied)) {
        throw new Error(
          "error" in applied && applied.error
            ? applied.error
            : "ナレッジを更新できませんでした"
        );
      }

      setSyncMessage(
        `ナレッジを${applied.updated}件更新・${applied.created}件追加しました（変更なし ${applied.unchanged}件、対象外 ${applied.skipped}件）`
      );
      setPendingSync(null);
      fetchKnowledges();
    } catch (error) {
      setSyncError(
        error instanceof Error
          ? error.message
          : "ナレッジの更新に失敗しました"
      );
    } finally {
      setSyncing(false);
    }
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
      title: specialty ? `${SPECIALTY_TITLE_PREFIX} ` : "",
      type: "custom",
      content: "",
      accountId: initialAccountId,
    });
  }

  const visibleKnowledges = knowledges.filter((k) =>
    specialty ? isSpecialtyKnowledge(k) : !isSpecialtyKnowledge(k)
  );

  const filtered = visibleKnowledges.filter((k) => {
    if (filter === "all") return true;
    if (filter === "common") return k.accountId === null;
    return k.accountId === filter;
  });
  const orderedFiltered = [...filtered].sort((a, b) => {
    const mappingA = findKnowledgeMapping(a.title);
    const mappingB = findKnowledgeMapping(b.title);
    const firstStepA =
      mappingA && mappingA.steps.length > 0
        ? Math.min(...mappingA.steps)
        : Number.POSITIVE_INFINITY;
    const firstStepB =
      mappingB && mappingB.steps.length > 0
        ? Math.min(...mappingB.steps)
        : Number.POSITIVE_INFINITY;
    return (
      firstStepA - firstStepB ||
      (mappingA?.priority ?? 999) - (mappingB?.priority ?? 999) ||
      a.title.localeCompare(b.title, "ja")
    );
  });

  async function handleSave() {
    setSaving(true);
    const saveForm = specialty
      ? {
          ...form,
          type: "custom",
          title: normalizeSpecialtyTitle(form.title),
        }
      : form;

    if (creating) {
      await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(saveForm),
      });
    } else if (editing) {
      await fetch("/api/knowledge", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editing, ...saveForm }),
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
  const selectedKnowledge =
    visibleKnowledges.find((k) => k.id === selectedId) || null;
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

  function renderKnowledgeCard(k: Knowledge) {
    return (
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
              {(() => {
                const m = findKnowledgeMapping(k.title);
                if (!m) return null;
                return m.steps.map((s) => (
                  <span
                    key={s}
                    className="ml-0.5 px-1 py-0.5 rounded text-[10px] font-mono bg-indigo-50 text-indigo-500"
                  >
                    S{s === 135 ? "13.5" : s}
                  </span>
                ));
              })()}
              <span className="ml-2 px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500">
                {specialty ? "専門ナレッジ" : typeLabels[k.type] || k.type}
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
    );
  }

  return (
    <section>
      <div className="flex items-start justify-between mb-3 gap-3">
        <p className="text-sm text-gray-500 flex-1">
          {specialty
            ? "投稿の判断軸や具体アクションに使う専門ナレッジを管理します。通常ナレッジとは分けて、1投稿につき1カテゴリだけが参照されます。"
            : "投稿生成に使うナレッジを管理します。「全アカウント共通」のナレッジは全てのアカウントで使われ、特定アカウントを指定したナレッジはそのアカウントの生成時のみ追加で使われます。"}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleKnowledgeSync}
            disabled={syncing || creating || editing !== null || aiProcessing}
            title="knowledgeフォルダで外部編集したMarkdownをアプリへ反映"
            className="px-4 py-2 rounded-lg text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 whitespace-nowrap disabled:opacity-50"
          >
            {syncing ? "確認中..." : "↻ ナレッジ更新"}
          </button>
          <button
            onClick={startCreate}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white whitespace-nowrap"
            style={{ background: "var(--accent)" }}
          >
            {specialty ? "+ 手動で追加" : "+ ナレッジ追加"}
          </button>
        </div>
      </div>

      {pendingSync && (
        <div className="mb-3 p-3 rounded-lg border border-blue-200 bg-blue-50 text-xs text-blue-800">
          <p className="font-medium">
            外部ナレッジの変更があります（更新 {pendingSync.updated}件・追加 {pendingSync.created}件）
          </p>
          <ul className="mt-2 space-y-1">
            {pendingSync.updates.slice(0, 5).map((item) => (
              <li key={`update-${item.id}`}>・更新：{item.title}</li>
            ))}
            {pendingSync.creations.slice(0, 5).map((item) => (
              <li key={`create-${item.relativePath}`}>・追加：{item.title}</li>
            ))}
            {pendingSync.updated + pendingSync.created > 10 && (
              <li>ほか {pendingSync.updated + pendingSync.created - 10}件</li>
            )}
          </ul>
          <p className="mt-2 text-blue-600">
            既存ナレッジはタイトル・本文を更新し、新しいMarkdownはナレッジとして追加します。削除は行いません。
          </p>
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={applyKnowledgeSync}
              disabled={syncing}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
            >
              {syncing
                ? "反映中..."
                : `${pendingSync.updated + pendingSync.created}件を反映`}
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingSync(null);
                setSyncMessage("ナレッジの反映をキャンセルしました。");
              }}
              disabled={syncing}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {syncMessage && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-green-200 bg-green-50 text-xs text-green-700">
          {syncMessage}
        </div>
      )}
      {syncError && (
        <div className="mb-3 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 whitespace-pre-wrap">
          {syncError}
        </div>
      )}

      {specialty && (
        <SpecialtyUrlImporter
          accounts={accounts}
          initialAccountId={
            filter !== "all" && filter !== "common" ? filter : null
          }
          onDraft={({ title, content, accountId }) => {
            setEditing(null);
            resetAiEdit();
            setForm({
              title: normalizeSpecialtyTitle(title),
              type: "custom",
              content,
              accountId,
            });
            setCreating(true);
          }}
        />
      )}

      <div className="mb-4 p-3 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-500 leading-relaxed">
        💡 {specialty
          ? "URLから作った内容は、確認・編集して「保存」を押すまでデータベースには追加されません。"
          : "ここで追加・編集・削除したナレッジは、このアプリ（中の小さなデータベース）に保存されます。"}
        {!specialty && (
          <>
        外部ソフトで <code>knowledge/</code> フォルダのMarkdownを編集した場合は、上の「ナレッジ更新」から差分を反映できます。
        既存ナレッジの本文・タイトル変更と、新しいMarkdownファイルの追加を反映します。削除は行いません。
          </>
        )}
      </div>

      {/* フィルタ */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="text-xs text-gray-500">対象:</span>
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          すべて ({visibleKnowledges.length})
        </FilterChip>
        <FilterChip
          active={filter === "common"}
          onClick={() => setFilter("common")}
        >
          全アカウント共通 (
          {visibleKnowledges.filter((k) => !k.accountId).length})
        </FilterChip>
        {accounts.map((a) => {
          const count = visibleKnowledges.filter(
            (k) => k.accountId === a.id
          ).length;
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

      {/* ビュー切替 */}
      {!specialty && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-gray-500">表示:</span>
          <button
            onClick={() => setViewMode("flow")}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${viewMode === "flow" ? "bg-indigo-100 text-indigo-700" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
          >
            投稿生成フロー順
          </button>
          <button
            onClick={() => setViewMode("flat")}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${viewMode === "flat" ? "bg-indigo-100 text-indigo-700" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
          >
            フラット
          </button>
        </div>
      )}

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
        {/* 投稿生成フロー順: 最初に参照するSTEPへ配置 */}
        {viewMode === "flow" && !specialty && (() => {
          type KnowledgeGroup = number | "other";
          const groupOrder: KnowledgeGroup[] = [
            ...STEP_DEFINITIONS.map((definition) => definition.step),
            "other",
          ];
          const groups = Object.fromEntries(
            groupOrder.map((step) => [String(step), [] as Knowledge[]])
          ) as Record<KnowledgeGroup, Knowledge[]>;
          for (const k of orderedFiltered) {
            const mapping = findKnowledgeMapping(k.title);
            const firstStep =
              mapping && mapping.steps.length > 0
                ? Math.min(...mapping.steps)
                : null;
            if (firstStep !== null && groups[firstStep]) {
              groups[firstStep].push(k);
            } else {
              groups.other.push(k);
            }
          }
          return (
            <>
              {groupOrder.map((step) => {
                const items = groups[step];
                if (!items || items.length === 0) return null;
                const definition =
                  typeof step === "number"
                    ? STEP_DEFINITIONS.find((item) => item.step === step)
                    : null;
                const label =
                  step === "other"
                    ? "生成フロー外・追加ナレッジ"
                    : `${definition?.label || `STEP${step}`} ${definition?.title || ""}`;
                const groupKey = String(step);
                const isCollapsed = collapsedGroups.has(groupKey);
                return (
                  <div key={groupKey} className="mb-2">
                    <button
                      onClick={() => setCollapsedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(groupKey)) next.delete(groupKey);
                        else next.add(groupKey);
                        return next;
                      })}
                      className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <span className="text-xs text-gray-400">{isCollapsed ? "▶" : "▼"}</span>
                      <span className="text-sm font-bold text-gray-600">{label}</span>
                      <span className="text-xs text-gray-400">({items.length})</span>
                    </button>
                    {!isCollapsed && items.map((k) => (
                      <div key={k.id} className="ml-4">
                        {renderKnowledgeCard(k)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          );
        })()}
        {/* Flat view or specialty */}
        {(viewMode === "flat" || specialty) &&
          (specialty ? filtered : orderedFiltered).map((k) => (
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
                  {(() => {
                    const m = findKnowledgeMapping(k.title);
                    if (!m) return null;
                    return m.steps.map((s) => (
                      <span
                        key={s}
                        className="ml-0.5 px-1 py-0.5 rounded text-[10px] font-mono bg-indigo-50 text-indigo-500"
                      >
                        S{s === 135 ? "13.5" : s}
                      </span>
                    ));
                  })()}
                  <span className="ml-2 px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500">
                    {specialty ? "専門ナレッジ" : typeLabels[k.type] || k.type}
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
            {visibleKnowledges.length === 0
              ? specialty
                ? "専門ナレッジがまだありません。URLまたは本文・文字起こしから追加できます。"
                : "ナレッジがまだありません。「+ ナレッジ追加」またはデフォルトナレッジをシードしてください。"
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
          emptyText={
            specialty
              ? "左の専門ナレッジをクリックすると、ここに全文が表示されます。"
              : "左のナレッジをクリックすると、ここに全文が表示されます。"
          }
        />
      </div>
      </div>
    </section>
  );
}

function SpecialtyUrlImporter({
  accounts,
  initialAccountId,
  onDraft,
}: {
  accounts: Account[];
  initialAccountId: string | null;
  onDraft: (draft: {
    title: string;
    content: string;
    accountId: string | null;
  }) => void;
}) {
  const [url, setUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [accountId, setAccountId] = useState<string | null>(initialAccountId);
  const [provider, setProvider] = useState<"auto" | "claude" | "codex">(
    "auto"
  );
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setAccountId(initialAccountId);
  }, [initialAccountId]);

  async function handleConvert() {
    if (!url.trim()) return;
    setProcessing(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/knowledge/from-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          sourceText: sourceText.trim(),
          provider,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "URLからのナレッジ化に失敗しました。");
        return;
      }

      onDraft({
        title: data.title,
        content: data.content,
        accountId,
      });
      const sourceMessage = data.fetched
        ? "URLの本文から変換案を作りました。"
        : "貼り付けた本文・文字起こしから変換案を作りました。";
      const providerMessage =
        data.providerUsed === "codex"
          ? data.fallbackFrom === "claude"
            ? "Claudeが使えなかったため、Codexへ自動で切り替えました。"
            : "Codexで変換しました。"
          : "Claudeで変換しました。";
      setMessage(
        `${sourceMessage} ${providerMessage} 下の内容を確認して保存してください。`
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "URLからのナレッジ化に失敗しました。"
      );
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-purple-200 bg-purple-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-purple-700">
            URLから専門ナレッジを作る
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-purple-600">
            記事はURLから本文取得を試します。YouTube・ログインが必要なページ・取得できないページは、下の欄に文字起こしや本文も貼ってください。
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            出典URL
          </label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={processing}
            placeholder="https://..."
            className="w-full rounded-lg border border-purple-200 bg-white px-3 py-2 text-sm focus:border-purple-400 focus:outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            本文・文字起こし（URLだけで取得できない場合）
          </label>
          <textarea
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
            disabled={processing}
            rows={5}
            placeholder="YouTubeの文字起こし、記事本文などを貼り付け..."
            className="w-full rounded-lg border border-purple-200 bg-white px-3 py-2 text-sm leading-relaxed focus:border-purple-400 focus:outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            生成AI
          </label>
          <select
            value={provider}
            onChange={(e) =>
              setProvider(e.target.value as "auto" | "claude" | "codex")
            }
            disabled={processing}
            className="w-full rounded-lg border border-purple-200 bg-white px-3 py-2 text-sm focus:border-purple-400 focus:outline-none disabled:opacity-50"
          >
            <option value="auto">自動切替（Claude → Codex）</option>
            <option value="codex">Codexを使う</option>
            <option value="claude">Claudeを使う</option>
          </select>
          <p className="mt-1 text-xs text-gray-400">
            自動切替は、Claudeの制限・エラー時にCodexへ切り替えます。どちらも月額プランのログインを使い、APIキーは使いません。
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            対象アカウント
          </label>
          <select
            value={accountId ?? ""}
            onChange={(e) => setAccountId(e.target.value || null)}
            disabled={processing}
            className="w-full rounded-lg border border-purple-200 bg-white px-3 py-2 text-sm focus:border-purple-400 focus:outline-none disabled:opacity-50"
          >
            <option value="">全アカウント共通</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} のみ
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-red-600">
          {error}
        </p>
      )}
      {message && (
        <p className="mt-3 text-xs leading-relaxed text-emerald-600">
          {message}
        </p>
      )}

      <button
        onClick={handleConvert}
        disabled={processing || !url.trim()}
        className="mt-3 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        style={{ background: "var(--accent)" }}
      >
        {processing ? "AIが変換中..." : "AIで変換してプレビュー"}
      </button>
    </div>
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
