"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { STEP_DEFINITIONS } from "@/lib/generation-steps";
import { parsePosts } from "@/lib/post-parser";

type Step = {
  id: string;
  stepNumber: number;
  stepLabel: string;
  status: string;
  summary: string | null;
  output: string | null;
  knowledgeRefs: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

type Session = {
  id: string;
  accountId: string;
  status: string;
  layer: string | null;
  category: string | null;
  hookType: string | null;
  templateName: string | null;
  currentStep: number;
  finalPostBody: string | null;
  error: string | null;
  createdAt: string;
  steps: Step[];
};

type EditablePost = {
  postNumber: number;
  items: string[];
  reviewStatus: "pending" | "approved" | "rejected";
  feedback: string;
};

type RejectedReview = {
  postNumber: number;
  feedback: string;
};

const LAYER_LABEL_RE = /^[ \t　]*\[L[123]\][ \t　]*(?:\r?\n)?/i;

function cleanPostBody(body: string): string {
  return body.replace(LAYER_LABEL_RE, "").trim();
}

function serializePosts(posts: EditablePost[]): string {
  return posts
    .map((post) =>
      post.items
        .map(
          (item, index) =>
            `■${index + 1}\n${cleanPostBody(item)}`
        )
        .join("\n\n")
    )
    .join("\n\n=====\n\n");
}

function parseKnowledgeRefs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function statusBadge(status: string) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    running: { bg: "#2563eb22", text: "#60a5fa", label: "進行中" },
    awaiting_approval: {
      bg: "#d9770622",
      text: "#f59e0b",
      label: "承認待ち",
    },
    approved: {
      bg: "#7c3aed22",
      text: "#a78bfa",
      label: "下書き保存済み",
    },
    completed: { bg: "#16a34a22", text: "#4ade80", label: "完了" },
    failed: { bg: "#dc262622", text: "#f87171", label: "失敗" },
  };
  const s = map[status] || { bg: "#64748b22", text: "#94a3b8", label: status };
  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: s.bg, color: s.text }}
    >
      {s.label}
    </span>
  );
}

function sessionStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    running: "進行中",
    awaiting_approval: "承認待ち",
    approved: "下書き保存済み",
    completed: "完了",
    failed: "失敗",
  };
  return labels[status] || status;
}

export default function GenerationFlowPage({
  accountId,
}: {
  accountId: string | null;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [approving, setApproving] = useState(false);
  const [approvalMessage, setApprovalMessage] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [editablePosts, setEditablePosts] = useState<EditablePost[]>([]);
  const [rejectedReviews, setRejectedReviews] = useState<RejectedReview[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSessions = useCallback(async () => {
    const params = new URLSearchParams();
    if (accountId) params.set("accountId", accountId);
    params.set("limit", "20");
    try {
      const response = await fetch(`/api/generation-flow/sessions?${params}`);
      const list = response.ok ? await response.json() : [];
      setSessions(list);
      return list as Session[];
    } catch {
      return [] as Session[];
    }
  }, [accountId]);

  const fetchActive = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    fetch("/api/generation-flow/active")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Session[]) => {
        const relevant = accountId
          ? list.find((s) => s.accountId === accountId)
          : list[0];
        setActiveSession(relevant || null);
        if (relevant) {
          setSessions((prev) => [
            relevant,
            ...prev.filter((s) => s.id !== relevant.id),
          ]);
        } else {
          fetchSessions();
        }
      })
      .catch(() => {});
  }, [accountId, fetchSessions]);

  useEffect(() => {
    fetchSessions();
    fetchActive();
  }, [fetchSessions, fetchActive]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const interval = activeSession ? 3000 : 10000;
    pollRef.current = setInterval(() => {
      fetchActive();
      if (!activeSession) fetchSessions();
    }, interval);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeSession, fetchActive, fetchSessions]);

  const availableSessions = accountId
    ? sessions.filter((s) => s.accountId === accountId)
    : sessions;
  const effectiveSelectedSessionId =
    selectedSessionId &&
    (activeSession?.id === selectedSessionId ||
      availableSessions.some((s) => s.id === selectedSessionId))
      ? selectedSessionId
      : null;
  const displaySession = effectiveSelectedSessionId
    ? activeSession?.id === effectiveSelectedSessionId
      ? activeSession
      : availableSessions.find((s) => s.id === effectiveSelectedSessionId) ||
        null
    : activeSession || availableSessions[0] || null;
  const stepsMap = new Map<number, Step>();
  if (displaySession) {
    for (const s of displaySession.steps) {
      stepsMap.set(s.stepNumber, s);
    }
  }

  const selectedStepData = selectedStep !== null ? stepsMap.get(selectedStep) : null;
  const selectedDef =
    selectedStep !== null
      ? STEP_DEFINITIONS.find((d) => d.step === selectedStep)
      : null;
  const needsFinalApproval =
    displaySession?.status === "awaiting_approval" &&
    !!displaySession.finalPostBody;
  const finalDraftApproved =
    displaySession?.status === "approved" ||
    displaySession?.status === "completed";
  const canEditFinalDraft = needsFinalApproval;
  const approvedPosts = editablePosts.filter(
    (post) => post.reviewStatus === "approved"
  );
  const approvedCount = approvedPosts.length;
  const rejectedCount = rejectedReviews.length;
  const pendingCount = editablePosts.filter(
    (post) => post.reviewStatus === "pending"
  ).length;
  const allReviewed =
    rejectedCount > 0 || editablePosts.length > 0
      ? pendingCount === 0
      : false;
  const allRejected = editablePosts.length === 0 && rejectedCount > 0;
  const hasEmptyApprovedPost = approvedPosts.some((post) =>
    post.items.some((item) => !cleanPostBody(item))
  );

  useEffect(() => {
    if (!displaySession?.finalPostBody) {
      setEditablePosts([]);
      setRejectedReviews([]);
      return;
    }
    const parsed = parsePosts(displaySession.finalPostBody);
    setEditablePosts(
      parsed.map((post, index) => ({
        postNumber: index + 1,
        items: post.items.map(cleanPostBody),
        reviewStatus: "pending",
        feedback: "",
      }))
    );
    setRejectedReviews([]);
  }, [displaySession?.id, displaySession?.finalPostBody]);

  function updatePostItem(
    postIndex: number,
    itemIndex: number,
    value: string
  ) {
    setEditablePosts((previous) =>
      previous.map((post, currentPostIndex) =>
        currentPostIndex === postIndex
          ? {
              ...post,
              items: post.items.map((item, currentItemIndex) =>
                currentItemIndex === itemIndex ? value : item
              ),
              reviewStatus: "pending",
            }
          : post
      )
    );
  }

  function setPostReviewStatus(
    postIndex: number,
    reviewStatus: EditablePost["reviewStatus"]
  ) {
    setEditablePosts((previous) =>
      previous.map((post, currentPostIndex) =>
        currentPostIndex === postIndex
          ? { ...post, reviewStatus }
          : post
      )
    );
  }

  function setPostFeedback(postIndex: number, feedback: string) {
    setEditablePosts((previous) =>
      previous.map((post, currentPostIndex) =>
        currentPostIndex === postIndex
          ? { ...post, feedback }
          : post
      )
    );
  }

  function rejectPost(postIndex: number) {
    const rejected = editablePosts[postIndex];
    if (!rejected) return;
    setRejectedReviews((reviews) => [
      ...reviews,
      {
        postNumber: rejected.postNumber,
        feedback: rejected.feedback.trim(),
      },
    ]);
    setEditablePosts((previous) =>
      previous.filter((post) => post.postNumber !== rejected.postNumber)
    );
  }

  async function approveFinalDraft() {
    if (
      !displaySession ||
      !allReviewed ||
      hasEmptyApprovedPost ||
      approving
    ) {
      return;
    }
    setApproving(true);
    setApprovalError("");
    setApprovalMessage("");
    try {
      const response = await fetch("/api/generation-flow/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: displaySession.id,
          finalPostBody: allRejected ? "" : serializePosts(approvedPosts),
          autoSave: true,
          updateExisting: finalDraftApproved,
          allRejected,
          reviewDecisions: [
            ...editablePosts.map((post) => ({
              postNumber: post.postNumber,
              status: post.reviewStatus,
              feedback: post.feedback.trim(),
            })),
            ...rejectedReviews.map((review) => ({
              ...review,
              status: "rejected" as const,
            })),
          ].sort((a, b) => a.postNumber - b.postNumber),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.error) {
        throw new Error(
          data?.error || `承認できませんでした (HTTP ${response.status})`
        );
      }
      setApprovalMessage(
        allRejected
          ? "すべての投稿を否認して、この生成を終了しました。"
          : "承認した投稿を下書きタブへ保存しました。"
      );
      await fetchSessions();
    } catch (error) {
      setApprovalError(
        error instanceof Error ? error.message : "承認できませんでした"
      );
    } finally {
      setApproving(false);
    }
  }

  function renderFinalDraftEditor() {
    return (
      <>
        {canEditFinalDraft && (
          <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
            <p className="mb-3 text-sm text-emerald-100">
              各投稿を「承認」または「否認」してください。ツリーは1つの投稿として判定し、各コマを個別に修正できます。
            </p>
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-white">
                承認 {approvedCount}
              </span>
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-white">
                否認 {rejectedCount}
              </span>
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-white">
                未確認 {pendingCount}
              </span>
            </div>
            <button
              type="button"
              onClick={approveFinalDraft}
              disabled={
                approving ||
                !allReviewed ||
                hasEmptyApprovedPost
              }
              className={`w-full rounded-lg px-5 py-3 text-base font-bold text-white shadow-lg transition-colors disabled:opacity-50 ${
                allRejected
                  ? "bg-red-600 hover:bg-red-500"
                  : "bg-emerald-500 hover:bg-emerald-400"
              }`}
            >
              {approving
                ? "確定中…"
                : allRejected
                  ? "すべて否認して終了"
                  : `承認した${approvedCount}投稿を下書きに保存`}
            </button>
            {!allReviewed && (
              <p className="mt-2 text-xs text-amber-200">
                すべての投稿を承認または否認すると保存できます。
              </p>
            )}
            {hasEmptyApprovedPost && (
              <p className="mt-2 text-xs text-amber-200">
                承認した投稿に空の本文があります。本文を入力してください。
              </p>
            )}
          </div>
        )}
        {finalDraftApproved && (
          <div className="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm font-medium text-green-300">
            ✓ 承認済み・下書き保存済み
          </div>
        )}
        {approvalMessage && (
          <div className="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
            {approvalMessage}
          </div>
        )}
        {approvalError && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {approvalError}
          </div>
        )}

        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          {editablePosts.map((post, postIndex) => (
            <section
              key={post.postNumber}
              className={`rounded-xl border bg-white p-4 shadow-sm ${
                post.reviewStatus === "approved"
                  ? "border-green-400 ring-2 ring-green-100"
                  : post.reviewStatus === "rejected"
                    ? "border-red-300 ring-2 ring-red-100"
                    : "border-gray-200"
              }`}
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="font-bold text-gray-800">
                  投稿{post.postNumber}
                </h4>
                <div className="flex items-center gap-2">
                  {post.reviewStatus === "approved" && (
                    <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-700">
                      承認
                    </span>
                  )}
                  {post.reviewStatus === "rejected" && (
                    <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700">
                      否認
                    </span>
                  )}
                  <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
                    {post.items.length > 1
                      ? `ツリー ${post.items.length}投稿`
                      : "単体投稿"}
                  </span>
                </div>
              </div>

              <div className="space-y-3">
                {post.items.map((item, itemIndex) => (
                  <div
                    key={itemIndex}
                    className="rounded-lg border border-gray-200 bg-gray-50 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium text-gray-500">
                        {post.items.length > 1
                          ? `${itemIndex + 1}投稿目`
                          : "本文"}
                      </span>
                      <span className="text-xs text-gray-400">
                        {cleanPostBody(item).length}文字
                      </span>
                    </div>
                    <textarea
                      value={item}
                      onChange={(event) =>
                        updatePostItem(
                          postIndex,
                          itemIndex,
                          event.target.value
                        )
                      }
                      readOnly={!canEditFinalDraft}
                      rows={Math.max(
                        5,
                        Math.min(14, item.split("\n").length + 4)
                      )}
                      className="w-full resize-y rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm leading-7 text-gray-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 read-only:bg-gray-50"
                    />
                  </div>
                ))}
              </div>

              <label className="mt-4 block text-sm font-medium text-gray-700">
                この投稿への指摘・修正メモ
                <textarea
                  value={post.feedback}
                  onChange={(event) =>
                    setPostFeedback(postIndex, event.target.value)
                  }
                  readOnly={!canEditFinalDraft}
                  rows={3}
                  placeholder="例：フックを具体的にする、2投稿目の言い回しを柔らかくする"
                  className="mt-1 w-full resize-y rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-gray-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100 read-only:bg-gray-50"
                />
              </label>

              {canEditFinalDraft && (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      setPostReviewStatus(postIndex, "approved")
                    }
                    className={`rounded-lg px-4 py-2.5 text-sm font-bold transition-colors ${
                      post.reviewStatus === "approved"
                        ? "bg-green-600 text-white"
                        : "border border-green-300 bg-green-50 text-green-700 hover:bg-green-100"
                    }`}
                  >
                    この投稿を承認
                  </button>
                  <button
                    type="button"
                    onClick={() => rejectPost(postIndex)}
                    className="rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm font-bold text-red-700 transition-colors hover:bg-red-100"
                  >
                    この投稿を否認
                  </button>
                </div>
              )}
            </section>
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="min-w-[720px] flex-1 overflow-y-auto">
      <div className="px-8 pt-6 pb-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-800">生成フロー</h2>
          {activeSession && (
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
              </span>
              <span className="text-sm text-blue-400">リアルタイム更新中</span>
            </div>
          )}
        </div>

        {/* Session selector */}
        {availableSessions.length > 0 && (
          <div className="mb-4 flex items-center gap-3">
            <label className="text-xs text-gray-400">セッション:</label>
            <select
              className="text-sm rounded-lg px-3 py-1.5 border border-gray-700 bg-transparent text-gray-200"
              value={displaySession?.id || ""}
              onChange={(e) => {
                setSelectedSessionId(e.target.value);
                setSelectedStep(null);
                setApprovalMessage("");
                setApprovalError("");
              }}
            >
              {availableSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {formatTime(s.createdAt)}
                  {s.layer ? ` [${s.layer}]` : ""}
                  {s.category ? ` Cat${s.category}` : ""}
                  {` — ${sessionStatusLabel(s.status)}`}
                </option>
              ))}
            </select>
            {displaySession && statusBadge(displaySession.status)}
            {displaySession?.hookType && (
              <span className="text-xs text-gray-400">
                フック: {displaySession.hookType}
              </span>
            )}
            {displaySession?.templateName && (
              <span className="text-xs text-gray-400">
                構成: {displaySession.templateName}
              </span>
            )}
          </div>
        )}

        {!displaySession && (
          <div className="text-center py-20 text-gray-400">
            <p className="text-lg mb-2">生成セッションがありません</p>
            <p className="text-sm">
              Claude
              Codeで投稿生成スキルを実行すると、ここに進行状況が表示されます
            </p>
          </div>
        )}

        {displaySession && (
          <div className="flex gap-6">
            {/* Left: Stepper */}
            <div className="w-80 shrink-0 space-y-1">
              {STEP_DEFINITIONS.map((def) => {
                const step = stepsMap.get(def.step);
                const status = step?.status || "pending";
                const isCurrent =
                  displaySession.status === "running" &&
                  displaySession.currentStep === def.step;
                const isSelected = selectedStep === def.step;

                return (
                  <button
                    key={def.step}
                    onClick={() =>
                      setSelectedStep(
                        selectedStep === def.step ? null : def.step
                      )
                    }
                    className="w-full text-left flex items-start gap-3 px-3 py-2 rounded-lg transition-colors"
                    style={{
                      background: isSelected
                        ? "rgba(99,102,241,0.15)"
                        : isCurrent
                          ? "rgba(59,130,246,0.1)"
                          : "transparent",
                    }}
                  >
                    {/* Status icon */}
                    <div className="mt-0.5 shrink-0">
                      {status === "completed" && (
                        <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center">
                          <span className="text-green-400 text-xs">✓</span>
                        </div>
                      )}
                      {status === "running" && (
                        <div className="w-5 h-5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                      )}
                      {status === "failed" && (
                        <div className="w-5 h-5 rounded-full bg-red-500/20 flex items-center justify-center">
                          <span className="text-red-400 text-xs">✕</span>
                        </div>
                      )}
                      {status === "skipped" && (
                        <div className="w-5 h-5 rounded-full bg-gray-600/30 flex items-center justify-center">
                          <span className="text-gray-500 text-xs">—</span>
                        </div>
                      )}
                      {status === "pending" && (
                        <div className="w-5 h-5 rounded-full border border-gray-600 opacity-40" />
                      )}
                    </div>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="text-xs font-mono"
                          style={{
                            color:
                              status === "completed"
                                ? "#4ade80"
                                : status === "running"
                                  ? "#60a5fa"
                                  : status === "failed"
                                    ? "#f87171"
                                    : "#64748b",
                          }}
                        >
                          {def.label}
                        </span>
                        <span
                          className={`text-sm ${status === "pending" ? "text-gray-500" : "text-gray-200"}`}
                        >
                          {def.title}
                        </span>
                      </div>
                      {/* Summary (1 line) */}
                      {step?.summary && (
                        <p className="text-xs text-gray-400 mt-0.5 truncate">
                          {step.summary}
                        </p>
                      )}
                      {/* Knowledge badges for running/current */}
                      {(status === "running" || isCurrent) && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {(
                            parseKnowledgeRefs(step?.knowledgeRefs ?? null)
                              .length > 0
                              ? parseKnowledgeRefs(step?.knowledgeRefs ?? null)
                              : def.knowledgeKeys
                          ).map((k) => (
                            <span
                              key={k}
                              className="px-1.5 py-0.5 rounded text-[10px]"
                              style={{
                                background: "rgba(139,92,246,0.2)",
                                color: "#c4b5fd",
                              }}
                            >
                              {k}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Right: Detail panel */}
            <div className="flex-1 min-w-0">
              {selectedStep !== null && selectedDef ? (
                <div
                  className="rounded-xl p-5 sticky top-6"
                  style={{ background: "var(--card-bg)" }}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-sm font-mono text-indigo-400">
                      {selectedDef.label}
                    </span>
                    <h3 className="text-lg font-bold text-gray-100">
                      {selectedDef.title}
                    </h3>
                    {selectedStepData && statusBadge(selectedStepData.status)}
                  </div>

                  {/* Knowledge refs */}
                  <div className="mb-4">
                    <p className="text-xs text-gray-400 mb-1">参照ナレッジ:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {(selectedStepData
                        ? parseKnowledgeRefs(selectedStepData.knowledgeRefs)
                            .length > 0
                          ? parseKnowledgeRefs(selectedStepData.knowledgeRefs)
                          : selectedDef.knowledgeKeys
                        : selectedDef.knowledgeKeys
                      ).map((k) => (
                        <span
                          key={k}
                          className="px-2 py-0.5 rounded-full text-xs"
                          style={{
                            background: "rgba(139,92,246,0.15)",
                            color: "#c4b5fd",
                          }}
                        >
                          {k}
                        </span>
                      ))}
                      {selectedDef.knowledgeKeys.length === 0 &&
                        !selectedStepData && (
                          <span className="text-xs text-gray-500">
                            外部ナレッジ参照なし
                          </span>
                        )}
                    </div>
                  </div>

                  {/* Summary */}
                  {selectedStepData?.summary && (
                    <div className="mb-4">
                      <p className="text-xs text-gray-400 mb-1">サマリ:</p>
                      <p className="text-sm text-gray-200">
                        {selectedStepData.summary}
                      </p>
                    </div>
                  )}

                  {/* Output */}
                  {selectedStepData?.output && (
                    <div>
                      <p className="text-xs text-gray-400 mb-1">出力:</p>
                      <pre className="text-xs text-gray-300 whitespace-pre-wrap bg-black/20 rounded-lg p-3 max-h-96 overflow-y-auto">
                        {selectedStepData.output}
                      </pre>
                    </div>
                  )}

                  {/* STEP13.5では、ステップを選ぶ前と同じ最終稿を残す */}
                  {selectedDef.step === 135 &&
                    displaySession.finalPostBody && (
                      <div className="mt-5 border-t border-white/10 pt-5">
                        {renderFinalDraftEditor()}
                      </div>
                    )}

                  {/* Timestamps */}
                  {selectedStepData && (
                    <div className="mt-4 flex gap-4 text-[10px] text-gray-500">
                      {selectedStepData.startedAt && (
                        <span>
                          開始: {formatTime(selectedStepData.startedAt)}
                        </span>
                      )}
                      {selectedStepData.completedAt && (
                        <span>
                          完了: {formatTime(selectedStepData.completedAt)}
                        </span>
                      )}
                    </div>
                  )}

                  {!selectedStepData && (
                    <p className="text-sm text-gray-500">
                      このステップはまだ実行されていません
                    </p>
                  )}
                </div>
              ) : (
                <div
                  className="rounded-xl p-8 text-center sticky top-6"
                  style={{ background: "var(--card-bg)" }}
                >
                  <p className="text-gray-400 text-sm">
                    左のステップをクリックすると詳細が表示されます
                  </p>
                  {displaySession.finalPostBody && (
                    <div className="mt-6 text-left">
                      {renderFinalDraftEditor()}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
