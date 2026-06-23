"use client";

type PostMediaLite = { id: string; publicUrl: string; status: string };

type Post = {
  id: string;
  groupNo: number;
  sortOrder: number;
  body: string;
  postType: string;
  charCount: number;
  scheduledDate: string | null;
  scheduledHour: number | null;
  scheduledMin: number | null;
  publishAt: string | null;
  status: string;
  media?: PostMediaLite[];
};

type Props = {
  posts: Post[];
  onClose: () => void;
};

function MediaStrip({ media }: { media?: PostMediaLite[] }) {
  const imgs = (media ?? []).filter((m) => m.publicUrl);
  if (imgs.length === 0) return null;
  return (
    <div className="tp-media">
      {imgs.map((m) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={m.id} src={m.publicUrl} alt="" className="tp-img" />
      ))}
    </div>
  );
}

function statusBadge(status: string) {
  switch (status) {
    case "draft":
      return { text: "下書き", cls: "b-draft" };
    case "queued":
      return { text: "待機中", cls: "b-wait" };
    case "posted":
      return { text: "投稿済", cls: "b-done" };
    case "error":
      return { text: "エラー", cls: "b-err" };
    default:
      return { text: status, cls: "b-draft" };
  }
}

function timeStr(p: Post) {
  if (p.publishAt) {
    const d = new Date(p.publishAt);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  const h = (p.scheduledHour ?? 0).toString().padStart(2, "0");
  const m = (p.scheduledMin ?? 0).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function dateLabel(p: Post) {
  const src = p.publishAt || p.scheduledDate;
  if (!src) return "";
  const d = new Date(src);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// Threadsアプリと同じ4アクションのアウトラインアイコン（いいね/返信/リポスト/シェア）
function MetaIcons() {
  const common = {
    width: 19,
    height: 19,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <div className="tp-meta">
      {/* いいね */}
      <svg {...common} aria-label="いいね">
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      </svg>
      {/* 返信 */}
      <svg {...common} aria-label="返信">
        <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      </svg>
      {/* リポスト */}
      <svg {...common} aria-label="リポスト">
        <path d="m17 2 4 4-4 4" />
        <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="m7 22-4-4 4-4" />
        <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      </svg>
      {/* シェア */}
      <svg {...common} aria-label="シェア">
        <path d="M22 2 11 13" />
        <path d="M22 2 15 22 11 13 2 9 22 2Z" />
      </svg>
    </div>
  );
}

export default function PostPreviewModal({ posts, onClose }: Props) {
  const sorted = [...posts].sort((a, b) => {
    if (a.groupNo !== b.groupNo) return a.groupNo - b.groupNo;
    return a.sortOrder - b.sortOrder;
  });
  const isThread = sorted.length > 1 || sorted[0]?.postType === "thread";
  const head = sorted[0];
  const badge = head ? statusBadge(head.status) : null;
  const time = head ? timeStr(head) : "";
  const date = head ? dateLabel(head) : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-[420px] h-[750px] max-h-[90vh] rounded-2xl overflow-hidden shadow-2xl flex flex-col"
        style={{ background: "#000" }}
        onClick={(e) => e.stopPropagation()}
      >
        <style>{`
          .tp-toolbar{position:sticky;top:0;z-index:10;background:#111;padding:10px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #222}
          .tp-close{background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer}
          .tp-close:hover{background:#333}
          .tp-info{color:#666;font-size:11px;margin-left:auto}
          .tp-feed{flex:1;overflow-y:auto;padding:0;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif}
          .tp-date-sep{padding:8px 14px;color:#555;font-size:11px;font-weight:600;border-top:1px solid #1a1a1a;text-align:center}
          .tp-post{padding:14px 16px 10px;border-top:.5px solid #1a1a1a}
          .tp-post.no-bt{border-top:none}
          .tp-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
          .tp-ava{width:38px;height:38px;border-radius:50%;background:#222;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
          .tp-name{color:#fff;font-size:14px;font-weight:700}
          .tp-time{color:#666;font-size:14px}
          .tp-text{color:#f5f5f5;font-size:14px;line-height:1.5;word-break:break-word;overflow-wrap:break-word;white-space:pre-wrap;padding-left:48px}
          .tp-meta{display:flex;align-items:center;gap:16px;margin-top:10px;color:#8a8a8a;font-size:11px;padding-left:48px}
          .tp-thread-line{margin-left:34px}
          .tp-thread-line .bar{width:2px;height:18px;background:#333}
          .tp-badge{display:inline-block;padding:2px 7px;border-radius:8px;font-size:9px;font-weight:700;margin-left:6px}
          .b-draft{background:#2a2000;color:#facc15}
          .b-wait{background:#0a1a2a;color:#60a5fa}
          .b-done{background:#0f2a0f;color:#4ade80}
          .b-err{background:#2a0f0f;color:#f87171}
          .tp-cc{color:#555;font-size:10px;margin-top:4px;padding-left:48px}
          .tp-cc-over{color:#f87171}
          .tp-media{display:flex;gap:6px;overflow-x:auto;padding:8px 0 0 48px}
          .tp-img{width:160px;height:160px;object-fit:cover;border-radius:12px;border:1px solid #222;flex-shrink:0}
          .tp-empty{padding:40px 14px;text-align:center;color:#555;font-size:13px;line-height:1.6}
        `}</style>

        <div className="tp-toolbar">
          <button className="tp-close" onClick={onClose}>
            ✕ 閉じる
          </button>
          <span className="tp-info">{sorted.length}件</span>
        </div>

        <div className="tp-feed">
          {sorted.length === 0 ? (
            <div className="tp-empty">投稿がありません</div>
          ) : (
            <>
              {date && <div className="tp-date-sep">{date}</div>}
              {!isThread &&
                sorted.map((p) => {
                  const cc = p.charCount || p.body.length;
                  return (
                    <div className="tp-post" key={p.id}>
                      <div className="tp-head">
                        <div className="tp-ava">👤</div>
                        <span className="tp-name">preview</span>
                        <span className="tp-time">
                          {timeStr(p)}
                          {badge && (
                            <span className={`tp-badge ${badge.cls}`}>
                              {badge.text}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="tp-text">{p.body}</div>
                      <MediaStrip media={p.media} />
                      <div className={`tp-cc${cc > 500 ? " tp-cc-over" : ""}`}>
                        {cc}文字
                      </div>
                      <MetaIcons />
                    </div>
                  );
                })}
              {isThread &&
                sorted.map((p, idx) => {
                  const cc = p.charCount || p.body.length;
                  return (
                    <div key={p.id}>
                      <div className={`tp-post${idx > 0 ? " no-bt" : ""}`}>
                        <div className="tp-head">
                          <div className="tp-ava">👤</div>
                          <span className="tp-name">preview</span>
                          <span className="tp-time">
                            {time}
                            {idx === 0 && badge && (
                              <span className={`tp-badge ${badge.cls}`}>
                                {badge.text}
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="tp-text">{p.body}</div>
                        <MediaStrip media={p.media} />
                        <div
                          className={`tp-cc${cc > 500 ? " tp-cc-over" : ""}`}
                        >
                          ■{idx + 1} {cc}文字
                        </div>
                        <MetaIcons />
                      </div>
                      {idx < sorted.length - 1 && (
                        <div className="tp-thread-line">
                          <div className="bar"></div>
                        </div>
                      )}
                    </div>
                  );
                })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
