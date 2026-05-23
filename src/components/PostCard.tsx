"use client";

import { useState } from "react";
import PostPreviewModal from "./PostPreviewModal";

type Post = {
  id: string;
  groupNo: number;
  body: string;
  postType: string;
  charCount: number;
  score: number | null;
  scheduledDate: string | null;
  scheduledHour: number | null;
  scheduledMin: number | null;
  publishAt: string | null;
  status: string;
  error: string | null;
  createdAt: string;
};

type PostCardProps = {
  post: Post;
  showActions?: boolean;
  groupPosts?: Post[];
  onQueue: (id: string, publishAt: string) => void | Promise<void>;
  onBackToDraft: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, body: string) => Promise<void>;
};

function typeLabel(postType: string) {
  switch (postType) {
    case "thread":
      return { text: "スレッド", color: "#7b1fa2", bg: "#f3e8fd" };
    case "standalone":
    default:
      return { text: "単体", color: "#2e7d32", bg: "#e8f5e9" };
  }
}

function formatDate(post: Post) {
  if (post.publishAt) {
    const d = new Date(post.publishAt);
    return `${d.getFullYear()}/${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  if (post.scheduledDate) {
    const d = new Date(post.scheduledDate);
    const h = post.scheduledHour?.toString().padStart(2, "0") ?? "00";
    const m = post.scheduledMin?.toString().padStart(2, "0") ?? "00";
    return `${d.getFullYear()}/${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")} ${h}:${m}`;
  }
  const d = new Date(post.createdAt);
  return `${d.getFullYear()}/${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function getDefaultDateTime() {
  const d = new Date();
  d.setHours(d.getHours() + 2);
  d.setMinutes(0, 0, 0);
  const yyyy = d.getFullYear();
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:00`;
}

export default function PostCard({
  post,
  showActions = true,
  groupPosts,
  onQueue,
  onBackToDraft,
  onDelete,
  onEdit,
}: PostCardProps) {
  const tag = typeLabel(post.postType);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [selectedDateTime, setSelectedDateTime] = useState(getDefaultDateTime);
  const [isEditing, setIsEditing] = useState(false);
  const [editedBody, setEditedBody] = useState(post.body);
  const [saving, setSaving] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiPreview, setAiPreview] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const previewPosts = groupPosts && groupPosts.length > 0 ? groupPosts : [post];

  function handleQueue() {
    setShowDatePicker(true);
  }

  async function confirmQueue() {
    if (queuing) return; // 二重送信防止
    setQueuing(true);
    try {
      const publishAt = new Date(selectedDateTime).toISOString();
      await onQueue(post.id, publishAt); // 完了まで待つ（クラウドオフロード時は数秒かかることがある）
    } finally {
      setQueuing(false);
      setShowDatePicker(false);
    }
  }

  function startEdit() {
    setEditedBody(post.body);
    setIsEditing(true);
  }

  const threadCount = groupPosts && groupPosts.length > 1 ? groupPosts.length : 0;

  async function confirmEdit() {
    const trimmed = editedBody.trim();
    // 変更なし → そのまま閉じる
    if (trimmed === post.body) {
      setIsEditing(false);
      return;
    }
    // 本文を空にして保存 → このコマを削除（スレッドを縮める）
    if (trimmed === "") {
      if (threadCount < 2) {
        // 単体投稿 or 1コマしかないツリー → 空にはできない
        window.alert(
          "この投稿の本文は空にできません。\n投稿ごと消したい場合は「キャンセル」してから「削除」ボタンを使ってください。"
        );
        return; // 編集モードは開いたまま（再入力 or キャンセルできる）
      }
      const ok = window.confirm(
        `この投稿（スレッド ${threadCount} コマ中の1つ）を削除して、残り ${threadCount - 1} コマでツリーを組み直しますか？`
      );
      if (!ok) return;
      setSaving(true);
      try {
        await onEdit(post.id, ""); // サーバ側でこのコマが削除される → 一覧再取得でこのカードが消える
        setIsEditing(false);
      } finally {
        setSaving(false);
      }
      return;
    }
    // 通常の本文編集
    setSaving(true);
    try {
      await onEdit(post.id, trimmed);
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit() {
    setEditedBody(post.body);
    setIsEditing(false);
    setAiInstruction("");
    setAiPreview(null);
    setAiError(null);
  }

  async function handleAiEdit() {
    if (!aiInstruction.trim() || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    setAiPreview(null);
    try {
      const res = await fetch("/api/posts/ai-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: post.id, instruction: aiInstruction }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiError(data.error || "AI修正に失敗しました");
        return;
      }
      setAiPreview(data.body);
    } catch {
      setAiError("通信エラーが発生しました");
    } finally {
      setAiLoading(false);
    }
  }

  function applyAiPreview() {
    if (!aiPreview) return;
    setEditedBody(aiPreview);
    setAiPreview(null);
    setAiInstruction("");
    setAiError(null);
  }

  return (
    <div
      className="rounded-xl p-4 md:p-6 mb-3 md:mb-4 shadow-sm border border-gray-100"
      style={{ background: "var(--card-bg)" }}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3 md:mb-4">
        <div className="flex items-center gap-2 md:gap-3">
          <span className="text-gray-400 font-mono text-xs md:text-sm">
            #{post.groupNo.toString().padStart(2, "0")}
          </span>
          <span
            className="px-2 py-0.5 rounded text-xs font-mono"
            style={{ color: tag.color, background: tag.bg }}
          >
            {tag.text}
          </span>
          {post.status === "error" && (
            <span className="px-2 py-0.5 rounded text-xs font-mono text-red-700 bg-red-50">
              エラー
            </span>
          )}
        </div>

        {/* 下書き → 編集 / キューに追加 / 削除 */}
        {post.status === "draft" && !isEditing && (
          <div className="flex flex-wrap gap-1.5 md:gap-2">
            {showActions && (
              <button
                onClick={() => setShowPreview(true)}
                className="px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium text-white transition-opacity hover:opacity-80"
                style={{ background: "#1f2937" }}
                title="Threads風スマホUIでプレビュー"
              >
                📱
              </button>
            )}
            <button
              onClick={startEdit}
              className="px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#607d8b" }}
            >
              編集
            </button>
            {showActions && (
              <>
                <button
                  onClick={handleQueue}
                  className="px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium text-white transition-opacity hover:opacity-80"
                  style={{ background: "#ff9800" }}
                >
                  キュー追加
                </button>
                <button
                  onClick={() => onDelete(post.id)}
                  className="px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium text-white transition-opacity hover:opacity-80"
                  style={{ background: "#f44336" }}
                >
                  削除
                </button>
              </>
            )}
          </div>
        )}

        {/* 編集モードのアクション（個別投稿） */}
        {isEditing && (
          <div className="flex gap-1.5 md:gap-2">
            <button
              onClick={confirmEdit}
              disabled={saving}
              className="px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              {saving ? "保存中..." : "保存"}
            </button>
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium text-gray-700 bg-gray-200 transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              キャンセル
            </button>
          </div>
        )}

        {/* キュー → 下書きに戻す / 削除 */}
        {showActions && post.status === "queued" && (
          <div className="flex flex-wrap gap-1.5 md:gap-2">
            <button
              onClick={() => setShowPreview(true)}
              className="px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#1f2937" }}
              title="Threads風スマホUIでプレビュー"
            >
              📱
            </button>
            <button
              onClick={() => onBackToDraft(post.id)}
              className="px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "var(--accent)" }}
            >
              下書きへ
            </button>
            <button
              onClick={() => onDelete(post.id)}
              className="px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#f44336" }}
            >
              削除
            </button>
          </div>
        )}

        {/* 投稿済 → プレビューのみ */}
        {showActions && post.status === "posted" && (
          <div className="flex gap-1.5">
            <button
              onClick={() => setShowPreview(true)}
              className="px-3 md:px-4 py-1.5 rounded-md text-xs md:text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#1f2937" }}
              title="Threads風スマホUIでプレビュー"
            >
              📱
            </button>
          </div>
        )}
      </div>

      {/* 日時指定モーダル */}
      {showDatePicker && (
        <div className="mb-4 p-3 md:p-4 rounded-lg bg-orange-50 border border-orange-200">
          <p className="text-sm font-medium text-gray-700 mb-2">
            投稿日時を指定してください
          </p>
          <div className="flex flex-wrap items-center gap-2 md:gap-3">
            <input
              type="datetime-local"
              value={selectedDateTime}
              onChange={(e) => setSelectedDateTime(e.target.value)}
              disabled={queuing}
              className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-orange-400 disabled:opacity-50"
            />
            <button
              onClick={confirmQueue}
              disabled={queuing}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-60"
              style={{ background: "#ff9800" }}
            >
              {queuing ? "追加中…" : "確定"}
            </button>
            <button
              onClick={() => setShowDatePicker(false)}
              disabled={queuing}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 bg-gray-100 transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              キャンセル
            </button>
          </div>
          {queuing && (
            <p className="text-xs text-orange-700 mt-2">
              キューに追加しています…（クラウドオフロード使用中だと数秒かかることがあります）
            </p>
          )}
        </div>
      )}

      {/* Body */}
      {isEditing ? (
        <div className="mb-4">
          <textarea
            value={editedBody}
            onChange={(e) => setEditedBody(e.target.value)}
            rows={Math.min(20, Math.max(6, editedBody.split("\n").length + 1))}
            className="w-full px-4 py-3 rounded-lg border border-gray-300 text-sm leading-relaxed font-sans text-gray-800 focus:outline-none focus:border-blue-400 whitespace-pre-wrap"
            autoFocus
          />
          <div className="text-xs text-gray-400 mt-1">
            {editedBody.length} 文字
            {editedBody.length > 500 && (
              <span className="text-red-500 ml-2">⚠ 500字を超えています</span>
            )}
            {editedBody.trim() === "" && (
              <span className="text-amber-600 ml-2">
                {threadCount >= 2
                  ? "← 空のまま保存すると、この投稿（スレッドの1コマ）はスレッドから削除されます。スレッド全体を消すなら「キャンセル」→「削除」ボタンへ"
                  : "← 本文は空にできません。投稿を消すなら「キャンセル」→「削除」ボタンへ"}
              </span>
            )}
          </div>

          {/* AI修正パネル */}
          <div className="mt-3 p-3 rounded-lg border border-purple-200 bg-purple-50">
            <p className="text-xs font-medium text-purple-700 mb-2">🤖 AI修正</p>
            {aiPreview === null ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAiEdit(); } }}
                  placeholder="例: もっと口語にして / フックを強くして / 200字に縮めて"
                  disabled={aiLoading}
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-purple-300 text-sm focus:outline-none focus:border-purple-500 bg-white disabled:opacity-50"
                />
                <button
                  onClick={handleAiEdit}
                  disabled={aiLoading || !aiInstruction.trim()}
                  className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-40"
                  style={{ background: "#7b1fa2" }}
                >
                  {aiLoading ? "生成中…" : "修正"}
                </button>
              </div>
            ) : (
              <div>
                <p className="text-xs text-purple-600 mb-1">修正結果のプレビュー：</p>
                <div className="text-sm whitespace-pre-wrap text-gray-800 bg-white p-3 rounded-lg border border-purple-200 mb-2 leading-relaxed">
                  {aiPreview}
                </div>
                <div className="text-xs text-gray-400 mb-2">{aiPreview.length} 文字</div>
                <div className="flex gap-2">
                  <button
                    onClick={applyAiPreview}
                    className="px-3 py-1.5 rounded-md text-xs font-medium text-white transition-opacity hover:opacity-80"
                    style={{ background: "#7b1fa2" }}
                  >
                    適用
                  </button>
                  <button
                    onClick={() => { setAiPreview(null); setAiError(null); }}
                    className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-700 bg-gray-200 transition-opacity hover:opacity-80"
                  >
                    やり直す
                  </button>
                </div>
              </div>
            )}
            {aiError && (
              <p className="text-xs text-red-600 mt-2">{aiError}</p>
            )}
          </div>
        </div>
      ) : (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-gray-800 mb-4">
          {post.body}
        </div>
      )}

      {/* Footer */}
      <div className="text-xs text-gray-400 flex gap-4">
        {post.score !== null && <span>スコア: {post.score}</span>}
        {post.status === "queued" && post.publishAt && (
          <span className="text-orange-500 font-medium">
            投稿予定: {formatDate(post)}
          </span>
        )}
        {post.status === "error" && post.error && (
          <span className="text-red-500">{post.error}</span>
        )}
        {post.status !== "queued" && <span>{formatDate(post)}</span>}
      </div>

      {showPreview && (
        <PostPreviewModal
          posts={previewPosts}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}
