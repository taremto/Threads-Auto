"use client";

import { useState, useEffect } from "react";
import PostPreviewModal from "./PostPreviewModal";

type PostMediaLite = {
  id: string;
  publicUrl: string;
  sortOrder: number;
  status: string;
};

type Post = {
  id: string;
  groupNo: number;
  sortOrder: number;
  body: string;
  postType: string;
  charCount: number;
  score: number | null;
  recommendedHour: number | null;
  recommendedLabel: string | null;
  recommendedReason: string | null;
  scheduledDate: string | null;
  scheduledHour: number | null;
  scheduledMin: number | null;
  publishAt: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  media?: PostMediaLite[];
};

type PostCardProps = {
  post: Post;
  showActions?: boolean;
  groupPosts?: Post[];
  cloudOffloadEnabled?: boolean;
  onQueue: (id: string, publishAt: string) => void | Promise<void>;
  onReschedule: (id: string, publishAt: string) => void | Promise<void>;
  onBackToDraft: (id: string) => void | Promise<void>;
  onRetryFailed: (id: string) => void | Promise<void>;
  onFailedToDraft: (id: string) => void | Promise<void>;
  onDelete: (id: string) => void;
  onEdit: (id: string, body: string) => Promise<void>;
  onExtendThread?: (
    postId: string,
    mode: "append" | "rewrite"
  ) => Promise<{ ok: boolean; error?: string }>;
};

function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type UploadImage = { base64: string; mimeType: string; fileName: string };

// 投稿前に画像をダウンスケール＋JPEG圧縮する（Threadsは表示時に再圧縮するので高解像度は不要）。
// スマホ写真(数MB)を数百KBにして、アップロードを1枚1分→数秒に。EXIF回転も反映する。
async function compressImageForUpload(
  file: File,
  maxDim = 1600,
  quality = 0.82
): Promise<UploadImage> {
  const passthrough = async (): Promise<UploadImage> => ({
    base64: await fileToBase64(file),
    mimeType: file.type || "image/jpeg",
    fileName: file.name || "image",
  });

  // アニメGIFはcanvasで静止画化されるので素通し。十分小さいjpegも触らない。
  if (file.type === "image/gif") return passthrough();
  if (file.type === "image/jpeg" && file.size <= 500 * 1024) return passthrough();

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return passthrough();
    }
    // JPEGはアルファ無しなので、透過部分が黒くならないよう白背景で塗る
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/jpeg", quality)
    );
    if (!blob) return passthrough();
    // 圧縮で逆に大きくなったら元を使う
    if (blob.size >= file.size) return passthrough();
    const base64 = await fileToBase64(blob);
    const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
    return { base64, mimeType: "image/jpeg", fileName: `${baseName}.jpg` };
  } catch {
    return passthrough();
  }
}

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

function toDateTimeLocalValue(d: Date) {
  const yyyy = d.getFullYear();
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  const mi = d.getMinutes().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function getDefaultDateTime(post?: Post) {
  const d = new Date();
  const recommendedHour =
    typeof post?.recommendedHour === "number" &&
    post.recommendedHour >= 0 &&
    post.recommendedHour <= 23
      ? post.recommendedHour
      : null;

  if (post?.status === "draft" && recommendedHour !== null) {
    d.setHours(recommendedHour, 0, 0, 0);
    const minSelectable = new Date(Date.now() + 60 * 60 * 1000);
    if (d.getTime() < minSelectable.getTime()) {
      d.setDate(d.getDate() + 1);
    }
  } else {
    d.setHours(d.getHours() + 2);
    d.setMinutes(0, 0, 0);
  }
  return toDateTimeLocalValue(d);
}

function getRescheduleDateTime(post: Post) {
  if (post.publishAt) {
    const current = new Date(post.publishAt);
    if (Number.isFinite(current.getTime()) && current.getTime() > Date.now() + 60_000) {
      return toDateTimeLocalValue(current);
    }
  }
  return getDefaultDateTime(post);
}

// Drive権限未承認などの生エラーを、操作手順つきの分かりやすい案内に変換
function friendlyMediaError(raw: string): string {
  if (/drive|createfolder|権限|permission|authoriz/i.test(raw)) {
    return (
      "Google Drive へのアクセス許可がまだ承認されていません。\n\n" +
      "【1回だけの操作】そのアカウントのスプレッドシートを開く → メニュー「自動投稿」→「🖼 画像投稿のDrive権限を承認」をクリック → 出てくるGoogle画面で『許可』。\n" +
      "（スプレッドシートのメニューに無い場合は、拡張機能 → Apps Script を開いて authorizeDrive を実行して許可）\n\n" +
      "許可が終わったら、もう一度この画像をドラッグ&ドロップしてください。"
    );
  }
  return raw;
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width="15" height="15" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function PostCard({
  post,
  showActions = true,
  groupPosts,
  cloudOffloadEnabled = false,
  onQueue,
  onReschedule,
  onBackToDraft,
  onRetryFailed,
  onFailedToDraft,
  onDelete,
  onEdit,
  onExtendThread,
}: PostCardProps) {
  const tag = typeLabel(post.postType);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [datePickerMode, setDatePickerMode] = useState<"queue" | "reschedule">("queue");
  const [selectedDateTime, setSelectedDateTime] = useState(() =>
    getDefaultDateTime(post)
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editedBody, setEditedBody] = useState(post.body);
  const [saving, setSaving] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiPreview, setAiPreview] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [extending, setExtending] = useState(false);
  const [showExtendMenu, setShowExtendMenu] = useState(false);
  const [revertingDraft, setRevertingDraft] = useState(false);
  const previewPosts = groupPosts && groupPosts.length > 0 ? groupPosts : [post];

  // ツリーへの追加生成（下書きのみ）。現在の投稿数とハード上限。
  const groupSize = groupPosts && groupPosts.length > 0 ? groupPosts.length : 1;
  const EXTEND_MAX = 6;
  const canExtendThread =
    post.status === "draft" && showActions && !!onExtendThread;

  async function runExtend(mode: "append" | "rewrite") {
    if (!onExtendThread || extending) return;
    if (groupSize >= EXTEND_MAX) {
      window.alert(`1つのツリーは最大${EXTEND_MAX}投稿までです。`);
      return;
    }
    const resultCount = groupSize + 1;
    // 4投稿以上は失敗率リスクを警告（両モード共通・ブロックはしない）
    const lagWarn =
      resultCount >= 4
        ? "\n\n※4投稿以上のツリーは、Threads API側の伝播ラグで投稿失敗率が上がり、読者の離脱も増えやすくなります。"
        : "";
    if (mode === "rewrite") {
      const ok = window.confirm(
        `このツリーを全文リライトして${resultCount}投稿に作り直します。\n手で直した本文・添付画像はリセットされます。続けますか？${lagWarn}`
      );
      if (!ok) return;
    } else if (resultCount >= 4) {
      const ok = window.confirm(
        `${resultCount}投稿目を追加します。それでも追加しますか？${lagWarn}`
      );
      if (!ok) return;
    }
    setShowExtendMenu(false);
    setExtending(true);
    try {
      const r = await onExtendThread(post.id, mode);
      if (!r.ok) {
        window.alert(
          `${mode === "rewrite" ? "ツリーの作り直し" : "続きの投稿の生成"}ができませんでした。\n\n${r.error || "もう一度お試しください。"}`
        );
      }
    } finally {
      setExtending(false);
    }
  }

  // 画像添付（下書きのみ）
  const [media, setMedia] = useState<PostMediaLite[]>(post.media ?? []);
  const [uploading, setUploading] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    setMedia(post.media ?? []);
    // 投稿が切り替わったとき（カード再利用）に添付を同期
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id]);

  // 下書き・キューには画像を付け外しできる（キューはGAS側の行も同期される）
  const canAttachMedia = post.status === "draft" || post.status === "queued";

  async function handleFiles(files: FileList | File[]) {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    if (!cloudOffloadEnabled) {
      alert(
        "画像添付にはクラウドオフロード（Google連携）の設定が必要です。\n設定 → アカウント編集 → ☁ クラウドオフロード から設定してください。"
      );
      return;
    }
    setUploadingCount(imgs.length);
    setUploading(true);
    try {
      // 送信前に各画像をダウンスケール＋JPEG圧縮（数MB→数百KB、アップロード高速化＋EXIF回転補正）
      const images = await Promise.all(imgs.map((f) => compressImageForUpload(f)));
      const r = await fetch("/api/posts/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: post.id, images }),
      });
      const d = await r.json();
      if (d.error) {
        alert(friendlyMediaError(d.error));
      } else {
        if (Array.isArray(d.media)) setMedia(d.media);
        if (d.errors?.length) {
          alert(friendlyMediaError(d.errors.join("\n")));
        }
        if (d.gasSyncWarning) alert(d.gasSyncWarning);
      }
    } catch (e) {
      alert("画像の添付に失敗しました: " + String(e));
    } finally {
      setUploading(false);
      setUploadingCount(0);
    }
  }

  async function removeMedia(id: string) {
    setMedia((prev) => prev.filter((m) => m.id !== id));
    try {
      const r = await fetch(`/api/posts/media?mediaId=${id}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (d?.gasSyncWarning) alert(d.gasSyncWarning);
    } catch {
      /* 表示は楽観的に消す。失敗してもサーバ側で再同期される */
    }
  }

  function handleQueue() {
    setDatePickerMode("queue");
    setSelectedDateTime(getDefaultDateTime(post));
    setShowDatePicker(true);
  }

  // 下書きに戻す（クラウドはGAS側のキャンセルで数秒かかるのでスピナーを出す）
  async function handleBackToDraft() {
    if (revertingDraft) return;
    setRevertingDraft(true);
    try {
      await onBackToDraft(post.id);
    } finally {
      setRevertingDraft(false);
    }
  }

  function handleReschedule() {
    setDatePickerMode("reschedule");
    setSelectedDateTime(getRescheduleDateTime(post));
    setShowDatePicker(true);
  }

  async function confirmQueue() {
    if (queuing) return; // 二重送信防止
    const selected = new Date(selectedDateTime);
    if (!Number.isFinite(selected.getTime()) || selected.getTime() < Date.now() + 60_000) {
      window.alert("今より1分以上あとの日時を選んでください。過ぎた時刻には予約できません。");
      return;
    }
    setQueuing(true);
    try {
      const publishAt = selected.toISOString();
      if (datePickerMode === "reschedule") {
        await onReschedule(post.id, publishAt);
      } else {
        await onQueue(post.id, publishAt); // 完了まで待つ（クラウドオフロード時は数秒かかることがある）
      }
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
  const recommendedLabel =
    post.recommendedLabel ||
    (typeof post.recommendedHour === "number"
      ? `${post.recommendedHour.toString().padStart(2, "0")}:00前後`
      : null);
  const queuedPastDue =
    post.status === "queued" &&
    post.publishAt !== null &&
    new Date(post.publishAt).getTime() + 60_000 <= Date.now();
  const isError = post.status === "error";

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

  const dropEnabled = canAttachMedia && cloudOffloadEnabled;

  return (
    <div
      className={`relative rounded-xl p-6 mb-4 shadow-sm border ${
        isError ? "border-red-200 bg-red-50" : "border-gray-100"
      } ${dragOver ? "ring-2 ring-blue-400" : ""}`}
      style={isError ? undefined : { background: "var(--card-bg)" }}
      onDragOver={
        dropEnabled
          ? (e) => {
              e.preventDefault();
              if (!dragOver) setDragOver(true);
            }
          : undefined
      }
      onDragLeave={
        dropEnabled
          ? (e) => {
              // 子要素間の移動では解除しない（カード外に出たときだけ消す）
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setDragOver(false);
            }
          : undefined
      }
      onDrop={
        dropEnabled
          ? (e) => {
              e.preventDefault();
              setDragOver(false);
              handleFiles(e.dataTransfer.files);
            }
          : undefined
      }
    >
      {/* ドラッグ中オーバーレイ（ThreadsのPCブラウザ風：投稿スペースに直接ドロップ） */}
      {dropEnabled && dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-400 bg-blue-50/85">
          <span className="text-sm font-semibold text-blue-600">
            📷 ここにドロップして画像を添付
          </span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="text-gray-400 font-mono text-sm">
            #{post.groupNo.toString().padStart(2, "0")}
          </span>
          <span
            className="px-2.5 py-0.5 rounded text-xs font-mono"
            style={{ color: tag.color, background: tag.bg }}
          >
            {tag.text}
          </span>
          {isError && (
            <span className="px-2.5 py-0.5 rounded text-xs font-mono font-bold text-white bg-red-600">
              エラー
            </span>
          )}
          {post.status === "draft" && recommendedLabel && showActions && (
            <span className="px-2.5 py-0.5 rounded text-xs font-medium text-blue-700 bg-blue-50">
              推奨 {recommendedLabel}
            </span>
          )}
        </div>

        {/* 下書き → 編集 / キューに追加 / 削除 */}
        {post.status === "draft" && !isEditing && (
          <div className="flex gap-2">
            {showActions && (
              <button
                onClick={() => setShowPreview(true)}
                className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
                style={{ background: "#1f2937" }}
                title="Threads風スマホUIでプレビュー"
              >
                📱 プレビュー
              </button>
            )}
            <button
              onClick={startEdit}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#607d8b" }}
            >
              編集
            </button>
            {canExtendThread && (
              <button
                onClick={() => setShowExtendMenu((v) => !v)}
                disabled={extending || groupSize >= EXTEND_MAX}
                title={
                  groupSize >= EXTEND_MAX
                    ? `1つのツリーは最大${EXTEND_MAX}投稿までです`
                    : "ツリーをAIで伸ばす（全文リライト or 末尾に1投稿追加）"
                }
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-50"
                style={{ background: "#7b1fa2" }}
              >
                {extending ? (
                  <>
                    <Spinner /> 生成中…
                  </>
                ) : (
                  <>🧵 ツリーを伸ばす{groupSize > 1 ? `（現在${groupSize}投稿）` : ""}</>
                )}
              </button>
            )}
            {showActions && (
              <>
                <button
                  onClick={handleQueue}
                  className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
                  style={{ background: "#ff9800" }}
                >
                  キューに追加
                </button>
                <button
                  onClick={() => onDelete(post.id)}
                  className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
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
          <div className="flex gap-2">
            <button
              onClick={confirmEdit}
              disabled={saving}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              {saving ? "保存中..." : "保存"}
            </button>
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-gray-700 bg-gray-200 transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              キャンセル
            </button>
          </div>
        )}

        {/* キュー → 下書きに戻す / 削除 */}
        {showActions && post.status === "queued" && (
          <div className="flex gap-2">
            <button
              onClick={() => setShowPreview(true)}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#1f2937" }}
              title="Threads風スマホUIでプレビュー"
            >
              📱 プレビュー
            </button>
            <button
              onClick={handleReschedule}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#ff9800" }}
            >
              時刻変更
            </button>
            <button
              onClick={handleBackToDraft}
              disabled={revertingDraft}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-60"
              style={{ background: "var(--accent)" }}
            >
              {revertingDraft ? (
                <>
                  <Spinner /> 戻しています…
                </>
              ) : (
                "下書きに戻す"
              )}
            </button>
            <button
              onClick={() => onDelete(post.id)}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#f44336" }}
            >
              削除
            </button>
          </div>
        )}

        {/* 投稿済 → プレビューのみ */}
        {showActions && post.status === "posted" && (
          <div className="flex gap-2">
            <button
              onClick={() => setShowPreview(true)}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#1f2937" }}
              title="Threads風スマホUIでプレビュー"
            >
              📱 プレビュー
            </button>
          </div>
        )}

        {/* エラー → 内容確認 / 下書きに戻す / 削除 */}
        {showActions && isError && (
          <div className="flex gap-2">
            <button
              onClick={() => setShowPreview(true)}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#1f2937" }}
              title="Threads風スマホUIでプレビュー"
            >
              📱 プレビュー
            </button>
            <button
              onClick={() => onRetryFailed(post.id)}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#ff9800" }}
            >
              失敗分だけ再試行
            </button>
            <button
              onClick={() => onFailedToDraft(post.id)}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "var(--accent)" }}
            >
              失敗分だけ下書きへ
            </button>
            <button
              onClick={() => onDelete(post.id)}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-opacity hover:opacity-80"
              style={{ background: "#f44336" }}
            >
              失敗分だけ削除
            </button>
          </div>
        )}
      </div>

      {/* ツリー拡張モード選択（全文リライト or 末尾追加） */}
      {showExtendMenu && canExtendThread && (
        <div className="mb-4 p-4 rounded-lg bg-violet-50 border border-violet-200">
          <p className="text-sm font-medium text-gray-700 mb-3">
            ツリーをどう伸ばす？（現在{groupSize}投稿 → {groupSize + 1}投稿）
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => runExtend("rewrite")}
              disabled={extending}
              className="text-left px-4 py-3 rounded-lg border border-violet-300 bg-white transition-colors hover:bg-violet-50 disabled:opacity-50"
            >
              <div className="text-sm font-semibold text-violet-700">
                ✨ 全文リライトして自然に+1（精度重視）
              </div>
              <div className="mt-0.5 text-xs text-gray-500">
                既存{groupSize}投稿を、同じテーマのまま自然な流れの{groupSize + 1}
                投稿に作り直します。接続が自然になります。※既存の本文・添付画像はリセットされます。
              </div>
            </button>
            <button
              onClick={() => runExtend("append")}
              disabled={extending}
              className="text-left px-4 py-3 rounded-lg border border-gray-200 bg-white transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              <div className="text-sm font-semibold text-gray-700">
                ➕ 末尾に1投稿だけ追加（既存はそのまま）
              </div>
              <div className="mt-0.5 text-xs text-gray-500">
                今の本文は触らず、自然につながる続きの1投稿だけ足します。
              </div>
            </button>
            <button
              onClick={() => setShowExtendMenu(false)}
              disabled={extending}
              className="self-start px-3 py-1 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* 日時指定モーダル */}
      {showDatePicker && (
        <div className="mb-4 p-4 rounded-lg bg-orange-50 border border-orange-200">
          <p className="text-sm font-medium text-gray-700 mb-2">
            {datePickerMode === "reschedule"
              ? "新しい予約日時を指定してください"
              : "投稿日時を指定してください"}
          </p>
          {recommendedLabel && (
            <p className="text-xs text-orange-700 mb-3">
              推奨投稿時間: {recommendedLabel}
              {post.recommendedReason ? `（${post.recommendedReason}）` : ""}
            </p>
          )}
          <div className="flex items-center gap-3">
            <input
              type="datetime-local"
              value={selectedDateTime}
              onChange={(e) => setSelectedDateTime(e.target.value)}
              disabled={queuing}
              className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-orange-400 disabled:opacity-50"
            />
            <button
              onClick={confirmQueue}
              disabled={queuing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-80 disabled:opacity-60"
              style={{ background: "#ff9800" }}
            >
              {queuing && <Spinner />}
              {queuing
                ? datePickerMode === "reschedule"
                  ? "変更中…"
                  : "追加中…"
                : "確定"}
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
            <p className="flex items-center gap-2 text-xs text-orange-700 mt-2">
              <Spinner className="shrink-0" />
              {datePickerMode === "reschedule"
                ? "予約時刻を変更しています…（クラウドオフロード使用中だと数秒かかることがあります）"
                : "キューに追加しています…（クラウドオフロード使用中だと数秒かかることがあります）"}
            </p>
          )}
        </div>
      )}

      {queuedPastDue && showActions && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-800">
          予約時刻を過ぎたため、自動投稿は止めています。「時刻変更」で新しい日時を指定してください。
        </div>
      )}

      {post.status === "draft" && recommendedLabel && showActions && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-blue-50 border border-blue-100 text-sm text-blue-900">
          <div className="font-semibold">推奨投稿時間: {recommendedLabel}</div>
          {post.recommendedReason && (
            <div className="text-xs text-blue-700 mt-1">
              {post.recommendedReason}
            </div>
          )}
        </div>
      )}

      {isError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-white px-4 py-3 text-sm leading-relaxed text-red-800">
          <div className="font-bold">投稿エラー</div>
          <div className="mt-1 break-words text-red-700">
            {post.error || "エラー内容が保存されていません。サポート用レポートを送って確認してください。"}
          </div>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-red-700">
            <li>アクセストークンを更新した場合は、自動投稿チェックで状態を確認してください。</li>
            <li>直前の投稿反映待ちなど一時的な失敗なら「失敗分だけ再試行」を押してください。</li>
            <li>本文を直す場合は「失敗分だけ下書きへ」で戻して、編集後にもう一度キューに追加してください。</li>
            <li>原因が分からなければ、自動投稿チェックの「サポート用レポートをコピー」を送ってください。</li>
          </ol>
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
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleAiEdit();
                    }
                  }}
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
                    onClick={() => {
                      setAiPreview(null);
                      setAiError(null);
                    }}
                    className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-700 bg-gray-200 transition-opacity hover:opacity-80"
                  >
                    やり直す
                  </button>
                </div>
              </div>
            )}
            {aiError && <p className="text-xs text-red-600 mt-2">{aiError}</p>}
          </div>
        </div>
      ) : (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-gray-800 mb-4">
          {post.body}
        </div>
      )}

      {/* 画像添付 */}
      {(canAttachMedia || media.length > 0) && (
        <div className="mb-4">
          {(media.length > 0 || (uploading && uploadingCount > 0)) && (
            <div className="flex flex-wrap gap-2 mb-2">
              {media.map((m) => (
                <div key={m.id} className="relative">
                  {m.publicUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={m.publicUrl}
                      alt=""
                      className="w-20 h-20 object-cover rounded-lg border border-gray-200"
                    />
                  ) : (
                    <div className="w-20 h-20 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center text-[10px] text-gray-400">
                      {m.status === "error" ? "失敗" : "処理中"}
                    </div>
                  )}
                  {canAttachMedia && (
                    <button
                      onClick={() => removeMedia(m.id)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-700 text-white text-xs flex items-center justify-center shadow hover:bg-red-500"
                      title="削除"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {uploading &&
                Array.from({ length: uploadingCount }).map((_, i) => (
                  <div
                    key={`sk-${i}`}
                    className="flex h-20 w-20 animate-pulse items-center justify-center rounded-lg border border-gray-200 bg-gray-100 text-sky-500"
                    title="アップロード中"
                  >
                    <Spinner />
                  </div>
                ))}
            </div>
          )}

          {canAttachMedia &&
            (cloudOffloadEnabled ? (
              <label
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                  uploading
                    ? "pointer-events-none border-sky-200 bg-sky-50 text-sky-600 font-medium"
                    : "cursor-pointer border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                }`}
                title="画像を添付（カードに直接ドラッグ&ドロップでもOK・複数可＝カルーセル）"
              >
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    if (e.target.files) handleFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                {uploading ? (
                  <>
                    <Spinner /> アップロード中…（{uploadingCount}枚）
                  </>
                ) : (
                  "📷 画像を追加"
                )}
              </label>
            ) : (
              <div className="text-xs text-gray-400">
                画像を添付するには、設定 → アカウント編集 → ☁ クラウドオフロードの設定が必要です。
              </div>
            ))}
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
        {post.status === "queued" && post.error && (
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
