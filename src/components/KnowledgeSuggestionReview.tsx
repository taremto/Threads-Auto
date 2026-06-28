"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Suggestion = {
  id: string;
  instruction: string;
  beforeBody: string | null;
  afterBody: string | null;
  createdAt: string;
};

type Knowledge = {
  id: string;
  accountId: string | null;
  title: string;
  isDefault: boolean;
};

type Props = {
  accountId: string;
  refreshKey: number;
};

function defaultTitle() {
  const date = new Date();
  return `投稿AI修正ルール ${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export default function KnowledgeSuggestionReview({
  accountId,
  refreshKey,
}: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [knowledges, setKnowledges] = useState<Knowledge[]>([]);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [targetKnowledgeId, setTargetKnowledgeId] = useState("");
  const [title, setTitle] = useState(defaultTitle);
  const [ruleText, setRuleText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const editableKnowledges = useMemo(
    () =>
      knowledges.filter(
        (knowledge) =>
          !knowledge.isDefault &&
          (knowledge.accountId === null || knowledge.accountId === accountId)
      ),
    [accountId, knowledges]
  );
  const current = suggestions[0] || null;
  const currentId = current?.id || "";
  const currentInstruction = current?.instruction || "";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [suggestionResponse, knowledgeResponse] = await Promise.all([
        fetch(
          `/api/knowledge/suggestions?accountId=${encodeURIComponent(accountId)}`,
          { cache: "no-store" }
        ),
        fetch("/api/knowledge?scope=all", { cache: "no-store" }),
      ]);
      const suggestionData = await suggestionResponse.json();
      const knowledgeData = await knowledgeResponse.json();
      if (!suggestionResponse.ok) {
        throw new Error(
          suggestionData.error || "ナレッジ反映候補を取得できませんでした"
        );
      }
      if (!knowledgeResponse.ok) {
        throw new Error(
          knowledgeData.error || "ナレッジ一覧を取得できませんでした"
        );
      }
      setSuggestions(Array.isArray(suggestionData) ? suggestionData : []);
      setKnowledges(Array.isArray(knowledgeData) ? knowledgeData : []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "ナレッジ反映候補を取得できませんでした"
      );
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!currentId) return;
    setRuleText(currentInstruction);
    setTitle(defaultTitle());
    setError("");
  }, [currentId, currentInstruction]);

  useEffect(() => {
    if (
      targetKnowledgeId &&
      editableKnowledges.some(
        (knowledge) => knowledge.id === targetKnowledgeId
      )
    ) {
      return;
    }
    setTargetKnowledgeId(editableKnowledges[0]?.id || "");
    if (editableKnowledges.length === 0) setMode("new");
  }, [editableKnowledges, targetKnowledgeId]);

  async function updateSuggestion(action: "apply" | "skip") {
    if (!current || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/knowledge/suggestions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "skip"
            ? { id: current.id, action }
            : {
                id: current.id,
                action,
                mode,
                ruleText,
                ...(mode === "new"
                  ? { title }
                  : { targetKnowledgeId }),
              }
        ),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "ナレッジへ反映できませんでした");
      }
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "ナレッジへ反映できませんでした"
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading && suggestions.length === 0) return null;
  if (!current && !error) return null;

  return (
    <section className="mb-5 rounded-xl border border-purple-200 bg-purple-50 p-4">
      {current ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-bold text-purple-900">
                このAI修正指示をナレッジに反映しますか？
              </h3>
              <p className="mt-1 text-xs text-purple-700">
                1件ずつ確認します（残り{suggestions.length}件）
              </p>
            </div>
            <span className="rounded-full bg-white px-2 py-1 text-xs text-purple-700">
              自動反映はしません
            </span>
          </div>

          <div className="mt-3 rounded-lg bg-white p-3 text-sm text-gray-800">
            {current.instruction}
          </div>

          {(current.beforeBody || current.afterBody) && (
            <details className="mt-2 text-xs text-gray-600">
              <summary className="cursor-pointer">修正前後を確認</summary>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <div className="whitespace-pre-wrap rounded-lg bg-white p-3">
                  <div className="mb-1 font-medium text-gray-500">修正前</div>
                  {current.beforeBody || "—"}
                </div>
                <div className="whitespace-pre-wrap rounded-lg bg-white p-3">
                  <div className="mb-1 font-medium text-gray-500">修正後</div>
                  {current.afterBody || "—"}
                </div>
              </div>
            </details>
          )}

          <div className="mt-4 grid gap-3">
            <label className="text-sm text-gray-700">
              ナレッジに入れるルール
              <textarea
                value={ruleText}
                onChange={(event) => setRuleText(event.target.value)}
                rows={3}
                className="mt-1 w-full rounded-lg border border-purple-200 bg-white px-3 py-2"
              />
            </label>

            <div className="flex flex-wrap gap-4 text-sm text-gray-700">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={mode === "new"}
                  onChange={() => setMode("new")}
                />
                新しいナレッジを作る
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={mode === "existing"}
                  disabled={editableKnowledges.length === 0}
                  onChange={() => setMode("existing")}
                />
                既存ナレッジを更新
              </label>
            </div>

            {mode === "new" ? (
              <label className="text-sm text-gray-700">
                新しいナレッジ名
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-purple-200 bg-white px-3 py-2"
                />
              </label>
            ) : (
              <label className="text-sm text-gray-700">
                反映先
                <select
                  value={targetKnowledgeId}
                  onChange={(event) =>
                    setTargetKnowledgeId(event.target.value)
                  }
                  className="mt-1 w-full rounded-lg border border-purple-200 bg-white px-3 py-2"
                >
                  {editableKnowledges.map((knowledge) => (
                    <option key={knowledge.id} value={knowledge.id}>
                      {knowledge.title}
                      {knowledge.accountId === null ? "（共通）" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => updateSuggestion("apply")}
              disabled={
                saving ||
                !ruleText.trim() ||
                (mode === "new" ? !title.trim() : !targetKnowledgeId)
              }
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? "反映中…" : "この内容を反映"}
            </button>
            <button
              type="button"
              onClick={() => updateSuggestion("skip")}
              disabled={saving}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-gray-600 disabled:opacity-50"
            >
              今回は見送る
            </button>
          </div>
        </>
      ) : (
        <div className="text-sm text-red-700">{error}</div>
      )}
    </section>
  );
}
