"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  ZAxis,
  Sector,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { parseAnalyticsCsv } from "@/lib/insights/csv-import";
import {
  aggregate,
  type AnalyticsItem,
  type AnalyticsResult,
} from "@/lib/insights/aggregate";
import { calcEr } from "@/lib/insights/metrics";

type Props = {
  accounts: { id: string; name: string }[];
};

// ── デザイントークン（refined light "instrument" ／ Linear・Vercel・Stripe 系） ──
const C = {
  ink: "#0B0D12",
  indigo: "#4F46E5",
  violet: "#8B5CF6",
  sky: "#0EA5E9",
  neutral: "#C2C8D2",
  grid: "#EDEFF2",
  gridStrong: "#E2E8F0",
  axis: "#8A93A2",
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const DOW_ORDER = ["月", "火", "水", "木", "金", "土", "日"]; // 参照ダッシュボードに合わせ月始まり
const TAGS = ["両方", "リーチ型", "エンゲージ型", "その他"] as const;
type TagName = (typeof TAGS)[number];
const TAG_COLOR: Record<TagName, string> = {
  両方: "#4F46E5",
  リーチ型: "#0EA5E9",
  エンゲージ型: "#8B5CF6",
  その他: "#C2C8D2",
};
const LIST_CAP = 50; // トップ投稿リストの表示上限

// 共通クラス（重複を避ける）
const CARD =
  "rounded-xl border border-[#E8EAED] bg-white shadow-[0_1px_2px_0_rgba(11,13,18,0.04)]";
const CARD_HOVER =
  CARD +
  " transition-[border-color,box-shadow] duration-150 hover:border-[#D6DAE0] hover:shadow-[0_2px_8px_-2px_rgba(11,13,18,0.08)]";
const BTN_PRIMARY =
  "shrink-0 rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-semibold text-white shadow-[0_1px_2px_0_rgba(11,13,18,0.05)] transition-[background-color,box-shadow] duration-150 hover:bg-[#4338CA] hover:shadow-[0_4px_12px_-2px_rgba(79,70,229,0.30)] active:scale-[0.98] disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed";
const BTN_SECONDARY =
  "rounded-lg border border-[#E8EAED] bg-white px-4 py-2 text-sm font-medium text-[#5B6472] transition-colors hover:bg-[#F4F5F7] hover:border-[#D6DAE0] active:bg-[#F1F3F6] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed";
const FIELD =
  "rounded-lg border border-[#E8EAED] bg-white px-3 py-1.5 text-sm text-[#0B0D12] transition-colors hover:border-[#D6DAE0] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#EEF0FE]";
const TIP_CARD =
  "rounded-xl border border-[#E8EAED] bg-white/95 px-3.5 py-2.5 shadow-[0_8px_24px_-6px_rgba(11,13,18,0.16)] backdrop-blur-sm";
const SECTION_TITLE =
  "text-[12px] font-semibold uppercase tracking-[0.06em] text-[#5B6472]";
const MICRO_LABEL =
  "text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#8A93A2]";

const TICK = {
  fontSize: 11,
  fill: C.axis,
  fontWeight: 500,
  fontFamily: "var(--font-num)",
  letterSpacing: "-0.01em",
} as const;
const CAT_TICK = { fontSize: 12, fill: C.axis } as const;

const compact = (n: number) =>
  Math.abs(n) >= 10000
    ? (n / 1000).toFixed(0) + "k"
    : Math.abs(n) >= 1000
    ? (n / 1000).toFixed(1) + "k"
    : String(n);

type CPost = {
  key: string;
  imp: number;
  er: number;
  likes: number;
  replies: number;
  reposts: number;
  text: string;
  url: string | null;
  isoDate: string | null;
  month: string | null; // "YYYY-MM"（JST）
  shortDate: string | null; // "M/D"（JST）
  fullDate: string | null; // "YYYY/M/D"（JST）
  dow: string | null; // 曜日（JST）
  hour: number | null;
  tag: TagName;
};

// タブを切り替えるとこのコンポーネントはアンマウントされる（各ページは表示中のみ生成）。
// 読み込んだCSV分析をセッション中は保持し、戻ってきたら復元するためのモジュールレベルキャッシュ。
// DBには入れない（ブラウザのフルリロードで消える＝従来どおりの揮発設計）。
type CompetitorCache = {
  posts: CPost[];
  aggResult: AnalyticsResult | null;
  competitorName: string;
  parsedCount: number;
  knowledgeText: string | null;
};
let sessionCache: CompetitorCache | null = null;

// ── 純粋ヘルパー ──

// 日時を JST の年月日・曜日・時に分解（マシンのTZに依存しない）
function jstParts(input: Date | string | null) {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const j = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return {
    year: j.getFullYear(),
    month: j.getMonth() + 1,
    day: j.getDate(),
    wd: j.getDay(),
    hour: j.getHours(),
  };
}

function recordToItem(
  r: ReturnType<typeof parseAnalyticsCsv>[number],
  i: number
): AnalyticsItem {
  return {
    key: r.threadsPostId ?? r.postUrl ?? `comp-${i}`,
    threadsPostId: r.threadsPostId,
    source: "historical",
    postedAt: r.postedAt,
    text: r.text,
    postUrl: r.postUrl,
    views: r.views,
    likes: r.likes,
    replies: r.replies,
    reposts: r.reposts,
    quotes: r.quotes,
    er: r.er,
  };
}

function competitorNameFromFilename(name: string): string {
  const base = name.replace(/\.csv$/i, "");
  const m = base.match(/^\d{8}_(.+?)_threads$/);
  return (m ? m[1] : base) || "競合アカウント";
}

const trunc = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + "…" : s;

export default function CompetitorAnalysisPage({ accounts }: Props) {
  const [posts, setPosts] = useState<CPost[]>(() => sessionCache?.posts ?? []);
  const [aggResult, setAggResult] = useState<AnalyticsResult | null>(
    () => sessionCache?.aggResult ?? null
  );
  const [competitorName, setCompetitorName] = useState(
    () => sessionCache?.competitorName ?? ""
  );
  const [parsedCount, setParsedCount] = useState(
    () => sessionCache?.parsedCount ?? 0
  );
  const [shiftJis, setShiftJis] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);

  // フィルタ（参照ダッシュボードと同じく、これが全チャート/表/KPIを駆動）
  const [filterMonth, setFilterMonth] = useState("all");
  const [filterTag, setFilterTag] = useState<"all" | TagName>("all");
  const [search, setSearch] = useState("");

  // トップ投稿リストの並び
  const [listSort, setListSort] = useState<"imp" | "er">("imp");

  // AIナレッジ
  const [knowledgeText, setKnowledgeText] = useState<string | null>(
    () => sessionCache?.knowledgeText ?? null
  );
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveAccountId, setSaveAccountId] = useState("");

  const [activePie, setActivePie] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const hasData = posts.length > 0;

  // 読み込んだ分析をセッションキャッシュへ保存（タブ切替でアンマウントされても保持）
  useEffect(() => {
    sessionCache = {
      posts,
      aggResult,
      competitorName,
      parsedCount,
      knowledgeText,
    };
  }, [posts, aggResult, competitorName, parsedCount, knowledgeText]);

  // ── CSV 解析（ブラウザ内・DB書き込みなし） ──
  async function parseFile(file: File) {
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      setMsg("CSVファイル（.csv）を選んでください。");
      return;
    }
    setParsing(true);
    setMsg(`CSVを解析中…（${file.name}）`);
    try {
      const csvText = shiftJis
        ? new TextDecoder("shift-jis").decode(await file.arrayBuffer())
        : await file.text();
      const records = parseAnalyticsCsv(csvText);
      if (records.length === 0) {
        setPosts([]);
        setAggResult(null);
        setParsedCount(0);
        setMsg(
          "有効な投稿データが見つかりませんでした。T-Insight Pro で書き出したCSVか確認してください。文字化けする場合は『Excelで開いた等で文字化けする』にチェックを入れて、もう一度読み込んでください。"
        );
        return;
      }
      // 「インプレッション数」列が無い＝別フォーマット（生スクレイプ等）の可能性。
      // そのまま集計すると数値が壊れるので、ここで弾いて分かりやすく案内する。
      if (records.every((r) => r.views == null)) {
        setPosts([]);
        setAggResult(null);
        setParsedCount(0);
        setMsg(
          "「インプレッション数」の列が見つかりませんでした。競合分析には T-Insight の分析CSV（日付・インプレッション数・本文…の列があるもの）を使ってください。"
        );
        return;
      }

      // CPost を構築
      const base: CPost[] = records.map((r, i) => {
        const p = jstParts(r.postedAt);
        const imp = Number(r.views) || 0;
        const er =
          r.er != null && Number.isFinite(r.er)
            ? r.er
            : calcEr(r.views, r.likes, r.replies, r.reposts, r.quotes) ?? 0;
        return {
          key: r.threadsPostId ?? r.postUrl ?? `comp-${i}`,
          imp,
          er,
          likes: Number(r.likes) || 0,
          replies: Number(r.replies) || 0,
          reposts: Number(r.reposts) || 0,
          text: (r.text || "").replace(/\n/g, " "),
          url: r.postUrl,
          isoDate: r.postedAt ? r.postedAt.toISOString() : null,
          month: p ? `${p.year}-${String(p.month).padStart(2, "0")}` : null,
          shortDate: p ? `${p.month}/${p.day}` : null,
          fullDate: p ? `${p.year}/${p.month}/${p.day}` : null,
          dow: p ? WD[p.wd] : null,
          hour: p ? p.hour : null,
          tag: "その他",
        };
      });

      // タグ＝P70閾値の4分類（参照ダッシュボードと同一ロジック）
      const impSorted = base.map((p) => p.imp).sort((a, b) => a - b);
      const erSorted = base.map((p) => p.er).sort((a, b) => a - b);
      const impTh = impSorted.length
        ? impSorted[Math.floor(impSorted.length * 0.7)]
        : 0;
      const erTh = erSorted.length
        ? erSorted[Math.floor(erSorted.length * 0.7)]
        : 0;
      for (const p of base) {
        const hi = p.imp >= impTh;
        const he = p.er >= erTh;
        p.tag = hi && he ? "両方" : hi ? "リーチ型" : he ? "エンゲージ型" : "その他";
      }

      // AIナレッジ用に既存集計も用意（全件・フィルタ非依存）
      const agg = aggregate(records.map(recordToItem));

      setPosts(base);
      setAggResult(agg);
      setParsedCount(records.length);
      setCompetitorName(competitorNameFromFilename(file.name));
      setFilterMonth("all");
      setFilterTag("all");
      setSearch("");
      setListSort("imp");
      setKnowledgeText(null);
      setMsg(`解析完了：${records.length}件の投稿を読み込みました。`);
    } catch (e) {
      setMsg(`解析に失敗しました: ${String(e)}`);
    } finally {
      setParsing(false);
    }
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await parseFile(file);
    if (fileRef.current) fileRef.current.value = "";
  }

  function onDropCsv(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    const csv =
      files.find((f) => /\.csv$/i.test(f.name) || f.type === "text/csv") ??
      files[0];
    if (csv) parseFile(csv);
  }

  // ── 月リスト ──
  const months = useMemo(() => {
    const s = new Set<string>();
    for (const p of posts) if (p.month) s.add(p.month);
    return [...s].sort();
  }, [posts]);

  // ── フィルタ適用 ──
  const filtered = useMemo(() => {
    const q = search.trim();
    return posts.filter((p) => {
      if (filterMonth !== "all" && p.month !== filterMonth) return false;
      if (filterTag !== "all" && p.tag !== filterTag) return false;
      if (q && !p.text.includes(q)) return false;
      return true;
    });
  }, [posts, filterMonth, filterTag, search]);

  // ── KPI ──
  const kpi = useMemo(() => {
    const totalPosts = filtered.length;
    const totalImp = filtered.reduce((s, p) => s + p.imp, 0);
    const avgEr =
      totalPosts > 0 ? filtered.reduce((s, p) => s + p.er, 0) / totalPosts : 0;
    const dm: Record<string, { imp: number; count: number }> = {};
    for (const p of filtered) {
      if (!p.dow) continue;
      (dm[p.dow] ||= { imp: 0, count: 0 }).imp += p.imp;
      dm[p.dow].count += 1;
    }
    let bestDay: string | null = null;
    let maxAvg = -1;
    for (const d in dm) {
      const avg = dm[d].imp / dm[d].count;
      if (avg > maxAvg) {
        maxAvg = avg;
        bestDay = d;
      }
    }
    return { totalPosts, totalImp, avgEr, bestDay };
  }, [filtered]);

  // ── 推移（月別 or 日別） ──
  const isAllMonths = filterMonth === "all";
  const trend = useMemo(() => {
    const m: Record<string, { imp: number; erSum: number; count: number }> = {};
    for (const p of filtered) {
      const key = isAllMonths ? p.month : p.shortDate;
      if (!key) continue;
      (m[key] ||= { imp: 0, erSum: 0, count: 0 }).imp += p.imp;
      m[key].erSum += p.er;
      m[key].count += 1;
    }
    return Object.keys(m)
      .sort((a, b) => (isAllMonths ? a.localeCompare(b) : cmpMD(a, b)))
      .map((k) => ({
        label: k,
        imp: m[k].imp,
        er: m[k].count > 0 ? Math.round((m[k].erSum / m[k].count) * 100) / 100 : 0,
      }));
  }, [filtered, isAllMonths]);

  // ── タグ別分布 ──
  const tagDist = useMemo(() => {
    const c: Record<TagName, number> = {
      両方: 0,
      リーチ型: 0,
      エンゲージ型: 0,
      その他: 0,
    };
    for (const p of filtered) c[p.tag] += 1;
    return TAGS.map((t) => ({ name: t, value: c[t], color: TAG_COLOR[t] })).filter(
      (d) => d.value > 0
    );
  }, [filtered]);

  // ── TOP10 ──
  const topImp = useMemo(
    () =>
      [...filtered]
        .sort((a, b) => b.imp - a.imp)
        .slice(0, 10)
        .map((p) => ({
          label: trunc(p.text || "（本文なし）", 18),
          value: p.imp,
          full: p.text,
        })),
    [filtered]
  );
  const topEr = useMemo(
    () =>
      [...filtered]
        .sort((a, b) => b.er - a.er)
        .slice(0, 10)
        .map((p) => ({
          label: trunc(p.text || "（本文なし）", 18),
          value: p.er,
          full: p.text,
        })),
    [filtered]
  );

  // ── 曜日別（平均閲覧・月→日） ──
  const dowData = useMemo(() => {
    const dm: Record<string, { imp: number; count: number }> = {};
    for (const d of DOW_ORDER) dm[d] = { imp: 0, count: 0 };
    for (const p of filtered) {
      if (p.dow && dm[p.dow]) {
        dm[p.dow].imp += p.imp;
        dm[p.dow].count += 1;
      }
    }
    return DOW_ORDER.map((d) => ({
      dow: d,
      avgImp: dm[d].count > 0 ? Math.round(dm[d].imp / dm[d].count) : 0,
    }));
  }, [filtered]);
  const hasDow = dowData.some((d) => d.avgImp > 0);

  // ── 散布図 ──
  const scatter = useMemo(
    () =>
      filtered.map((p) => ({
        views: p.imp,
        er: p.er,
        text: p.text,
        postUrl: p.url,
        color: TAG_COLOR[p.tag],
      })),
    [filtered]
  );

  // ── トップ投稿ランキング（フィルタ後を listSort で並べ、上位のみ） ──
  const ranked = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => (listSort === "er" ? b.er - a.er : b.imp - a.imp));
    return arr.slice(0, LIST_CAP);
  }, [filtered, listSort]);

  // 最も伸びた曜日（AI用・全件）
  const bestWeekdayAll = useMemo(() => {
    const dm: Record<string, { imp: number; count: number }> = {};
    for (const p of posts) {
      if (!p.dow) continue;
      (dm[p.dow] ||= { imp: 0, count: 0 }).imp += p.imp;
      dm[p.dow].count += 1;
    }
    let best: string | null = null;
    let maxAvg = -1;
    for (const d in dm) {
      const avg = dm[d].imp / dm[d].count;
      if (avg > maxAvg) {
        maxAvg = avg;
        best = d;
      }
    }
    return best;
  }, [posts]);

  // ── AIナレッジ生成 ──
  async function generateKnowledge() {
    if (!aggResult) return;
    setGenerating(true);
    setMsg("AIが競合データからナレッジを作成中…（30秒〜2分ほどかかります）");
    try {
      const topPosts = aggResult.topPosts.slice(0, 10).map((p, i) => {
        const wh = jstParts(p.postedAt);
        return {
          rank: i + 1,
          views: p.views,
          er: p.er,
          weekday: wh ? WD[wh.wd] : null,
          hour: wh ? wh.hour : null,
          text: (p.text || "").slice(0, 280),
        };
      });
      const hourlyTop = [...aggResult.hourly]
        .filter((h) => h.count > 0)
        .sort((a, b) => b.avgViews - a.avgViews)
        .slice(0, 5);
      const body = {
        competitorName: competitorName || "競合アカウント",
        stats: {
          totalPosts: aggResult.totals.posts,
          totalViews: aggResult.totals.views,
          avgViews: aggResult.totals.avgViews,
          avgEr: aggResult.totals.avgEr,
          p80Views: aggResult.p80Views,
          p80Er: aggResult.p80Er,
          bestWeekday: bestWeekdayAll,
          timeBands: aggResult.timeBands,
          hourlyTop,
        },
        topPosts,
      };
      const r = await fetch("/api/competitor/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok && d.knowledge) {
        setKnowledgeText(d.knowledge);
        setMsg("ナレッジを生成しました。内容を確認して保存してください。");
      } else {
        setMsg(`生成に失敗しました: ${d.error || `HTTP ${r.status}`}`);
      }
    } catch (e) {
      setMsg(`生成に失敗しました: ${String(e)}`);
    } finally {
      setGenerating(false);
    }
  }

  async function saveKnowledge() {
    if (!knowledgeText) return;
    setSaving(true);
    try {
      const r = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: saveAccountId || undefined,
          type: "custom",
          title: `競合分析: ${competitorName || "競合アカウント"}`,
          content: knowledgeText,
          isDefault: false,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        const scope = saveAccountId
          ? accounts.find((a) => a.id === saveAccountId)?.name ?? "選択アカウント"
          : "全アカウント共通";
        setMsg(
          `ナレッジに保存しました（${scope}／設定→ナレッジで確認・編集できます）`
        );
      } else {
        setMsg(`保存に失敗しました: ${d.error || `HTTP ${r.status}`}`);
      }
    } catch (e) {
      setMsg(`保存に失敗しました: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-w-[760px] flex-1 overflow-y-auto bg-[#F7F8FA]">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-8 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-[#0B0D12]">
            競合分析
          </h2>
          {competitorName && (
            <span className="inline-flex items-center gap-2 rounded-md border border-[#E8EAED] bg-white px-2.5 py-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[#8A93A2]">
                対象
              </span>
              <span className="text-[13px] font-medium text-[#5B6472]">
                {competitorName}
              </span>
              <span className="font-num text-[12px] text-[#8A93A2]">
                {parsedCount}
                <span className="ml-px text-[10px]">投稿</span>
              </span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-[#8A93A2]">
            <input
              type="checkbox"
              checked={shiftJis}
              onChange={(e) => setShiftJis(e.target.checked)}
            />
            Excelで開いた等で文字化けする
          </label>
          {hasData && (
            <button onClick={() => fileRef.current?.click()} className={BTN_SECONDARY}>
              別のCSVを読み込む
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className="mx-8 mb-4 rounded-lg border border-[#CDE9F6] bg-[#E6F4FB] px-4 py-2.5 text-sm text-[#0369A1]">
          {msg}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={onImportFile}
      />

      {/* 未読込：ドロップゾーン */}
      {!hasData && (
        <div className="px-8 pb-10">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setDragging(false);
            }}
            onDrop={onDropCsv}
            className={`group relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-20 text-center transition-all duration-200 ${
              dragging
                ? "border-[#4F46E5] bg-[#EEF0FE] ring-4 ring-[#EEF0FE]"
                : "border-[#D6DAE0] bg-white hover:border-[#8A93A2]"
            }`}
          >
            <span className="mb-1 flex h-12 w-12 items-center justify-center rounded-xl border border-[#E8EAED] bg-[#F4F5F7] text-xl text-[#8A93A2] group-hover:border-[#DDE0FB] group-hover:text-[#4F46E5]">
              ⬆
            </span>
            {parsing ? (
              <span className="flex items-center gap-2 text-sm font-medium text-[#4F46E5]">
                <span className="h-2 w-2 animate-ping rounded-full bg-[#4F46E5]" />
                解析中…
              </span>
            ) : (
              <>
                <span className="text-[15px] font-semibold tracking-tight text-[#0B0D12]">
                  競合アカウントのCSVをドラッグ&ドロップ
                </span>
                <span className="text-xs text-[#AEB6C2]">
                  またはクリックしてファイルを選択
                </span>
                <span className="mt-2 max-w-md text-xs leading-relaxed text-[#8A93A2]">
                  T-Insight Pro で書き出した
                  <code className="mx-1 rounded-md border border-[#E8EAED] bg-[#F4F5F7] px-1.5 py-0.5 font-mono text-[11px] text-[#5B6472]">
                    YYYYMMDD_アカウント名_threads.csv
                  </code>
                  に対応。読み込んだデータはこの画面の中だけで分析され、保存はされません（DBには入りません）。
                </span>
              </>
            )}
          </label>
        </div>
      )}

      {/* 読込後：ダッシュボード */}
      {hasData && (
        <div className="space-y-4 px-8 pb-10">
          {/* フィルタ */}
          <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-[#E8EAED] bg-white px-4 py-2.5 shadow-[0_1px_2px_0_rgba(11,13,18,0.04)]">
            <span className={MICRO_LABEL}>絞り込み</span>
            <select
              value={filterMonth}
              onChange={(e) => setFilterMonth(e.target.value)}
              className={FIELD}
            >
              <option value="all">全期間（月別推移）</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select
              value={filterTag}
              onChange={(e) => setFilterTag(e.target.value as "all" | TagName)}
              className={FIELD}
            >
              <option value="all">全てのタグ</option>
              {TAGS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="キーワード検索…"
              className={`min-w-[160px] flex-1 ${FIELD}`}
            />
            <span className="font-num text-[12px] text-[#8A93A2]">
              {filtered.length}
              <span className="ml-px text-[10px]">件</span>
            </span>
          </div>

          {/* KPI */}
          <div className="grid grid-cols-4 gap-3">
            <Card label="総投稿数" value={kpi.totalPosts} />
            <Card label="総閲覧数 (Imp)" value={kpi.totalImp} color={C.sky} />
            <Card
              label="平均ER (%)"
              value={kpi.avgEr}
              decimals={2}
              suffix="%"
              color={C.indigo}
            />
            <div className={`${CARD_HOVER} p-4`}>
              <div className="mb-2.5 flex items-center gap-1.5">
                <span
                  className="h-1 w-1 rounded-full"
                  style={{ background: C.violet }}
                />
                <p className={MICRO_LABEL}>最も伸びた曜日</p>
              </div>
              <p className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-[#0B0D12]">
                {kpi.bestDay ? `${kpi.bestDay}曜` : "—"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Card label="いいね" value={sumLikes(filtered)} color={C.indigo} />
            <Card label="返信" value={sumReplies(filtered)} color={C.violet} />
            <Card label="リポスト" value={sumReposts(filtered)} color={C.sky} />
          </div>

          <p className="text-[11px] text-[#8A93A2]">
            基準値（このCSV内で算出）: P80閲覧 ={" "}
            <span className="font-num">{(aggResult?.p80Views ?? 0).toLocaleString()}</span> / P80_ER ={" "}
            <span className="font-num">{aggResult?.p80Er ?? 0}</span>% / 平均閲覧/投稿 ={" "}
            <span className="font-num">{(aggResult?.totals.avgViews ?? 0).toLocaleString()}</span>
          </p>

          {/* 推移グラフ（月別 / 日別） */}
          <ChartBox title={isAllMonths ? "月別推移" : "日別推移"}>
            {trend.length === 0 ? (
              <Empty />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart
                  data={trend}
                  margin={{ top: 8, right: 8, bottom: 0, left: -6 }}
                >
                  <defs>
                    <linearGradient id="areaViewsC" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.sky} stopOpacity={0.18} />
                      <stop offset="55%" stopColor={C.sky} stopOpacity={0.06} />
                      <stop offset="100%" stopColor={C.sky} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    stroke={C.grid}
                    strokeDasharray="2 6"
                    strokeWidth={1}
                    vertical={false}
                    shapeRendering="crispEdges"
                  />
                  <XAxis
                    dataKey="label"
                    tick={TICK}
                    axisLine={false}
                    tickLine={false}
                    tickMargin={10}
                    minTickGap={24}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId="left"
                    tick={TICK}
                    axisLine={false}
                    tickLine={false}
                    width={44}
                    tickFormatter={compact}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={TICK}
                    axisLine={false}
                    tickLine={false}
                    width={38}
                  />
                  <Tooltip
                    content={<MetricTip />}
                    cursor={{
                      stroke: C.gridStrong,
                      strokeWidth: 1,
                      strokeDasharray: "3 3",
                    }}
                  />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{
                      fontSize: 11,
                      color: "#5B6472",
                      paddingTop: 8,
                      fontWeight: 500,
                      letterSpacing: "0.01em",
                    }}
                  />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="imp"
                    stroke={C.sky}
                    strokeWidth={2}
                    fill="url(#areaViewsC)"
                    name="閲覧"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff", fill: C.sky }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="er"
                    stroke={C.indigo}
                    strokeWidth={2}
                    name="平均ER(%)"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff", fill: C.indigo }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </ChartBox>

          {/* タグ別分布 × 曜日別分析 */}
          <div className="grid grid-cols-2 gap-4">
            <ChartBox title="タグ別分布（P70基準の型）">
              {tagDist.length === 0 ? (
                <Empty />
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={tagDist}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={54}
                      outerRadius={86}
                      paddingAngle={3}
                      stroke="#ffffff"
                      strokeWidth={3}
                      activeIndex={activePie}
                      activeShape={renderActiveSlice}
                      onMouseEnter={(_, i) => setActivePie(i)}
                    >
                      {tagDist.map((s) => (
                        <Cell key={s.name} fill={s.color} />
                      ))}
                    </Pie>
                    <Legend
                      iconType="circle"
                      iconSize={8}
                      verticalAlign="bottom"
                      height={28}
                      wrapperStyle={{ fontSize: 11, color: "#5B6472", paddingTop: 8 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </ChartBox>

            <ChartBox title="曜日別分析（平均閲覧数・JST）">
              {!hasDow ? (
                <Empty />
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart
                    data={dowData}
                    margin={{ top: 8, right: 8, bottom: 0, left: -6 }}
                  >
                    <defs>
                      <linearGradient id="barSkyC" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.sky} stopOpacity={1} />
                        <stop offset="100%" stopColor={C.sky} stopOpacity={0.55} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      stroke={C.grid}
                      strokeDasharray="2 6"
                      strokeWidth={1}
                      vertical={false}
                      shapeRendering="crispEdges"
                    />
                    <XAxis
                      dataKey="dow"
                      tick={CAT_TICK}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={TICK}
                      axisLine={false}
                      tickLine={false}
                      width={44}
                      tickFormatter={compact}
                    />
                    <Tooltip
                      content={<MetricTip />}
                      cursor={{ fill: "rgba(14,165,233,0.06)", radius: 6 }}
                    />
                    <Bar
                      dataKey="avgImp"
                      fill="url(#barSkyC)"
                      radius={[6, 6, 0, 0]}
                      maxBarSize={44}
                      name="平均閲覧"
                      activeBar={{ fill: C.sky, fillOpacity: 1 }}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartBox>
          </div>

          {/* 閲覧数TOP10 × ER TOP10（横棒） */}
          <div className="grid grid-cols-2 gap-4">
            <ChartBox title="閲覧数 TOP 10">
              <HBars data={topImp} color={C.sky} unit="" />
            </ChartBox>
            <ChartBox title="エンゲージメント率 TOP 10">
              <HBars data={topEr} color={C.violet} unit="%" />
            </ChartBox>
          </div>

          {/* 散布図 */}
          {scatter.length > 0 && (
            <ChartBox title="閲覧数 × ER 散布図（点をクリックで投稿を開く）">
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#8A93A2]">
                {TAGS.map((t) => (
                  <span key={t} className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: TAG_COLOR[t] }}
                    />
                    {t}
                  </span>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 8, right: 12, bottom: 0, left: -6 }}>
                  <CartesianGrid stroke={C.grid} strokeDasharray="2 6" />
                  <XAxis
                    type="number"
                    dataKey="views"
                    name="閲覧"
                    tick={TICK}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={compact}
                  />
                  <YAxis
                    type="number"
                    dataKey="er"
                    name="ER(%)"
                    tick={TICK}
                    axisLine={false}
                    tickLine={false}
                    width={40}
                  />
                  <ZAxis range={[42, 42]} />
                  <Tooltip
                    cursor={{ stroke: C.gridStrong, strokeDasharray: "2 4" }}
                    content={<ScatterTooltip />}
                  />
                  <Scatter
                    name="投稿"
                    data={scatter}
                    cursor="pointer"
                    onClick={(node) => {
                      const url = (node as unknown as { postUrl?: string | null })
                        ?.postUrl;
                      if (url) window.open(url, "_blank", "noopener");
                    }}
                  >
                    {scatter.map((d, i) => (
                      <Cell
                        key={i}
                        fill={d.color}
                        fillOpacity={0.72}
                        stroke="#fff"
                        strokeWidth={1}
                      />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </ChartBox>
          )}

          {/* トップ投稿ランキング */}
          <div className={CARD}>
            <div className="flex items-center justify-between border-b border-[#E8EAED] px-4 py-3">
              <h3 className={SECTION_TITLE}>
                トップ投稿（{listSort === "er" ? "ER順" : "閲覧順"}）{" "}
                <span className="font-num text-[#8A93A2]">{filtered.length}</span>
              </h3>
              <div className="inline-flex rounded-lg border border-[#E8EAED] bg-white p-0.5 text-xs">
                {(["imp", "er"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setListSort(k)}
                    className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                      listSort === k
                        ? "bg-[#0B0D12] text-white"
                        : "text-[#8A93A2] hover:text-[#5B6472]"
                    }`}
                  >
                    {k === "imp" ? "閲覧順" : "ER順"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              {ranked.map((p, i) => {
                const maxV =
                  listSort === "er" ? ranked[0]?.er || 1 : ranked[0]?.imp || 1;
                const cur = listSort === "er" ? p.er : p.imp;
                const barPct = Math.max(4, Math.round((cur / maxV) * 100));
                const highEr = p.er >= (aggResult?.p80Er ?? Infinity);
                return (
                  <div
                    key={p.key}
                    className="relative flex items-center border-b border-[#EEF0F2] px-4 py-3 transition-colors last:border-0 hover:bg-[#F7F8FA]"
                  >
                    <div
                      className="pointer-events-none absolute inset-y-1.5 left-0 rounded-r-lg"
                      style={{
                        width: `${barPct}%`,
                        background:
                          "linear-gradient(90deg, rgba(79,70,229,0.10), rgba(14,165,233,0.025))",
                      }}
                    />
                    <div className="relative z-10 flex w-full items-center gap-3.5">
                      <RankBadge rank={i + 1} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-[#0B0D12]">
                          {p.text || "（本文なし）"}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <Metric
                            icon={<EyeIcon />}
                            value={p.imp.toLocaleString()}
                            color="#0EA5E9"
                          />
                          <Metric
                            icon={<HeartIcon />}
                            value={p.likes.toLocaleString()}
                            color="#F43F5E"
                          />
                          <Metric
                            icon={<ChatIcon />}
                            value={p.replies.toLocaleString()}
                            color="#8B5CF6"
                          />
                          <span
                            className="inline-flex items-center rounded-md px-1.5 py-0.5 font-num text-[11px] font-semibold"
                            style={
                              highEr
                                ? { background: "#ECFDF5", color: "#059669" }
                                : { background: "#F1F3F6", color: "#8A93A2" }
                            }
                          >
                            ER {p.er}%
                          </span>
                          {p.fullDate && (
                            <span className="ml-auto font-num text-[11px] text-[#AEB6C2]">
                              {p.fullDate}
                            </span>
                          )}
                        </div>
                      </div>
                      {p.url && (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-[12px] font-medium text-[#0EA5E9] hover:underline"
                        >
                          開く ↗
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
              {filtered.length > LIST_CAP && (
                <div className="px-4 py-2.5 text-center text-[11px] text-[#AEB6C2]">
                  上位 {LIST_CAP} 件を表示中（全 {filtered.length} 件 ／
                  絞り込みで対象を絞れます）
                </div>
              )}
            </div>
          </div>

          {/* AIナレッジ化 */}
          <div className={CARD}>
            <div className="flex items-center justify-between border-b border-[#E8EAED] px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded-md bg-[#EEF0FE] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#4338CA] ring-1 ring-inset ring-[#DDE0FB]">
                    AI
                  </span>
                  <h3 className={SECTION_TITLE}>競合ナレッジ抽出</h3>
                </div>
                <p className="mt-1 text-xs text-[#8A93A2]">
                  競合の勝ちパターンを抽出し、自分の投稿生成にそのまま使えるナレッジにします（全期間データから生成）。
                </p>
              </div>
              <button
                onClick={generateKnowledge}
                disabled={generating || !aggResult}
                className={BTN_PRIMARY}
              >
                {generating ? (
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/90" />
                    生成中…
                  </span>
                ) : (
                  "AIでナレッジ化"
                )}
              </button>
            </div>

            {knowledgeText != null && (
              <div className="space-y-3 p-4">
                <textarea
                  value={knowledgeText}
                  onChange={(e) => setKnowledgeText(e.target.value)}
                  rows={16}
                  className="w-full resize-y rounded-lg border border-[#E8EAED] bg-[#F7F8FA] p-4 font-mono text-[12px] leading-relaxed text-[#0B0D12] shadow-[inset_0_1px_2px_rgba(11,13,18,0.04)] transition-shadow focus:border-[#4F46E5] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#EEF0FE]"
                />
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <label className="text-xs text-[#8A93A2]">保存先</label>
                  <select
                    value={saveAccountId}
                    onChange={(e) => setSaveAccountId(e.target.value)}
                    className={FIELD}
                  >
                    <option value="">全アカウント共通</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={saveKnowledge}
                    disabled={saving || !knowledgeText.trim()}
                    className={BTN_SECONDARY}
                  >
                    {saving ? "保存中…" : "ナレッジに保存"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// "M/D" の比較（月日順）
function cmpMD(a: string, b: string): number {
  const [am, ad] = a.split("/").map(Number);
  const [bm, bd] = b.split("/").map(Number);
  return am !== bm ? am - bm : ad - bd;
}

const sumLikes = (a: CPost[]) => a.reduce((s, p) => s + p.likes, 0);
const sumReplies = (a: CPost[]) => a.reduce((s, p) => s + p.replies, 0);
const sumReposts = (a: CPost[]) => a.reduce((s, p) => s + p.reposts, 0);

// ── 共有ツールチップ（推移・曜日別） ──
type TipP = {
  dataKey?: string | number;
  name?: string;
  value?: number | string;
  color?: string;
};
function MetricTip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TipP[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className={TIP_CARD}>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#8A93A2]">
        {label}
      </div>
      {payload.map((p, i) => {
        const isEr =
          String(p.dataKey) === "er" || String(p.name).includes("ER");
        return (
          <div key={i} className="flex items-center gap-2 text-[12px]">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: p.color }}
            />
            <span className="text-[#5B6472]">{p.name}</span>
            <span className="ml-auto font-num text-[12.5px] font-semibold text-[#0B0D12]">
              {Number(p.value).toLocaleString()}
              {isEr ? "%" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── 横棒チャート（TOP10用） ──
function HBars({
  data,
  color,
  unit,
}: {
  data: { label: string; value: number; full: string }[];
  color: string;
  unit: string;
}) {
  if (data.length === 0) return <Empty />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(210, data.length * 34)}>
      <BarChart
        layout="vertical"
        data={data}
        margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
      >
        <CartesianGrid
          stroke={C.grid}
          strokeDasharray="2 6"
          strokeWidth={1}
          horizontal={false}
          shapeRendering="crispEdges"
        />
        <XAxis
          type="number"
          tick={TICK}
          axisLine={false}
          tickLine={false}
          tickFormatter={compact}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={220}
          tick={{ fontSize: 11, fill: "#475569" }}
          tickMargin={6}
          axisLine={false}
          tickLine={false}
          interval={0}
        />
        <Tooltip
          cursor={{ fill: "rgba(99,102,241,0.06)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as { full: string; value: number };
            return (
              <div className={`max-w-[260px] ${TIP_CARD}`}>
                <div className="line-clamp-3 text-[12px] text-[#5B6472]">
                  {d.full || "（本文なし）"}
                </div>
                <div className="mt-1.5 font-num text-[12.5px] font-semibold text-[#0B0D12]">
                  {d.value.toLocaleString()}
                  {unit}
                </div>
              </div>
            );
          }}
        />
        <Bar
          dataKey="value"
          fill={color}
          fillOpacity={0.9}
          radius={[0, 5, 5, 0]}
          maxBarSize={18}
          activeBar={{ fillOpacity: 1 }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── ランキング行の部品 ──
function EyeIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function HeartIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 21s-6.7-4.35-9.33-8.36C.9 9.9 2.2 6.2 5.6 6.2c1.9 0 3.3 1.1 4.4 2.6 1.1-1.5 2.5-2.6 4.4-2.6 3.4 0 4.7 3.7 2.93 6.44C18.7 16.65 12 21 12 21Z" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10Z" />
    </svg>
  );
}
function Metric({
  icon,
  value,
  color,
}: {
  icon: React.ReactNode;
  value: string;
  color: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span style={{ color }} className="flex items-center">
        {icon}
      </span>
      <span className="font-num font-semibold text-[#0B0D12]">{value}</span>
    </span>
  );
}
function RankBadge({ rank }: { rank: number }) {
  const top = rank <= 3;
  const topBg = ["#4F46E5", "#7B74EC", "#A9A4F3"][rank - 1];
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-num text-xs font-bold"
      style={
        top
          ? {
              background: topBg,
              color: "#fff",
              boxShadow: "0 1px 3px rgba(79,70,229,0.4)",
            }
          : { background: "#F1F3F6", color: "#8A93A2" }
      }
    >
      {rank}
    </div>
  );
}

// ── 表示用ヘルパー ──

function useCountUp(target: number, duration = 700): number {
  const [val, setVal] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else {
        setVal(target);
        prev.current = target;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderActiveSlice(props: any) {
  const {
    cx,
    cy,
    innerRadius,
    outerRadius,
    startAngle,
    endAngle,
    fill,
    payload,
    percent,
    value,
  } = props;
  return (
    <g>
      <text
        x={cx}
        y={cy - 8}
        textAnchor="middle"
        style={{ fontSize: 13, fontWeight: 700, fill: "#0B0D12" }}
      >
        {payload.name}
      </text>
      <text
        x={cx}
        y={cy + 12}
        textAnchor="middle"
        style={{ fontSize: 12, fill: "#64748b", fontFamily: "var(--font-num)" }}
      >
        {Number(value).toLocaleString()}（{(percent * 100).toFixed(0)}%）
      </text>
      <Sector
        cx={cx}
        cy={cy}
        innerRadius={innerRadius}
        outerRadius={outerRadius + 6}
        startAngle={startAngle}
        endAngle={endAngle}
        fill={fill}
        stroke="#ffffff"
        strokeWidth={3}
      />
      <Sector
        cx={cx}
        cy={cy}
        innerRadius={outerRadius + 9}
        outerRadius={outerRadius + 11}
        startAngle={startAngle}
        endAngle={endAngle}
        fill={fill}
      />
    </g>
  );
}

function ScatterTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { views: number; er: number; text: string } }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className={`max-w-[230px] ${TIP_CARD}`}>
      <div className="line-clamp-2 text-[12px] text-[#5B6472]">
        {d.text || "（本文なし）"}
      </div>
      <div className="mt-1.5 font-num text-[12px] text-[#0369A1]">
        閲覧 {d.views.toLocaleString()} ／ ER {d.er}%
      </div>
      <div className="mt-0.5 text-[11px] text-[#AEB6C2]">クリックで投稿を開く</div>
    </div>
  );
}

function Card({
  label,
  value,
  color,
  suffix,
  decimals = 0,
}: {
  label: string;
  value: number;
  color?: string;
  suffix?: string;
  decimals?: number;
}) {
  const n = useCountUp(value);
  const display =
    decimals > 0 ? n.toFixed(decimals) : Math.round(n).toLocaleString();
  return (
    <div className={`${CARD_HOVER} p-4`}>
      <div className="mb-2.5 flex items-center gap-1.5">
        {color && (
          <span
            className="h-1 w-1 rounded-full"
            style={{ background: color }}
          />
        )}
        <p className={MICRO_LABEL}>{label}</p>
      </div>
      <p className="font-num text-[28px] font-semibold leading-none tracking-[-0.02em] text-[#0B0D12]">
        {display}
        {suffix && (
          <span className="ml-0.5 text-[15px] font-medium tracking-normal text-[#AEB6C2]">
            {suffix}
          </span>
        )}
      </p>
    </div>
  );
}

function ChartBox({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`${CARD} p-4`}>
      <h3 className={`mb-3 ${SECTION_TITLE}`}>{title}</h3>
      {children}
    </div>
  );
}

function Empty() {
  return (
    <div className="flex h-[240px] flex-col items-center justify-center gap-2 text-[#8A93A2]">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#E8EAED] bg-[#F4F5F7] text-[#AEB6C2]">
        ▦
      </span>
      <span className="text-[13px]">データがありません</span>
    </div>
  );
}
