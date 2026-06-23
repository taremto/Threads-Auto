"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  Sector,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

type LabeledPost = {
  key: string;
  threadsPostId: string | null;
  source: "post" | "historical";
  text: string;
  postUrl: string | null;
  postedAt: string | null;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  er: number;
  label: "engage" | "reach" | null;
};

type AnalyticsData = {
  accountId: string;
  accountName: string;
  degraded: boolean;
  insightsLastFetchedAt: string | null;
  historicalCount: number;
  availableRange: { from: string | null; to: string | null };
  totals: {
    posts: number;
    withInsights: number;
    views: number;
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    avgViews: number;
    avgEr: number;
  };
  statusCounts: Record<string, number>;
  p80Views: number;
  p80Er: number;
  threshold: number;
  timeSeries: { date: string; views: number; er: number; count: number }[];
  timeBands: { band: string; avgEr: number; avgViews: number; count: number }[];
  hourly: { hour: number; avgEr: number; avgViews: number; count: number }[];
  topPosts: LabeledPost[];
  distribution: {
    views: number;
    er: number;
    label: "engage" | "reach" | null;
    postUrl: string | null;
    text: string;
  }[];
  labeledPosts: LabeledPost[];
};

type Props = {
  accountId: string | null;
  accounts: { id: string; name: string }[];
  onAccountChange: (id: string) => void;
};

// 統一カラーパレット：原色を避け、クール系（インディゴ〜シアン）で統一した"設計された"配色。
// 1つの主役（インディゴ）＋ 調和する近似色。中立はごく薄いスレート。
const C = {
  ink: "#0f172a", // 数値・見出し（slate-900）
  indigo: "#6366f1", // 主役アクセント（ER / エンゲージ型）
  violet: "#8b5cf6",
  blue: "#3b82f6",
  cyan: "#06b6d4",
  sky: "#0ea5e9", // 閲覧 / リーチ型
  neutral: "#cbd5e1", // その他（slate-300）
  grid: "#eef2f7", // 目盛り線（極薄）
  axis: "#94a3b8", // 軸ラベル（slate-400）
};

const PERIODS: { key: string; label: string; days: number | null }[] = [
  { key: "7", label: "7日", days: 7 },
  { key: "30", label: "30日", days: 30 },
  { key: "90", label: "90日", days: 90 },
  { key: "all", label: "全期間", days: null },
];

// 数値がスッとカウントアップする（前回値→新値へ補間）。プレミアムな"動き"。
function useCountUp(target: number, duration = 700): number {
  const [val, setVal] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
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

// ドーナツでホバー中のスライスを少し立たせ、中央に名前と値を出す（インタラクティブ）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderActiveSlice(props: any) {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill, payload, percent, value } =
    props;
  return (
    <g>
      <text x={cx} y={cy - 8} textAnchor="middle" style={{ fontSize: 13, fontWeight: 700, fill: "#0f172a" }}>
        {payload.name}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" style={{ fontSize: 12, fill: "#64748b" }}>
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

function HourTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { hour: number; avgEr: number; avgViews: number; count: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow">
      <div className="font-bold text-gray-700">{d.hour}時台</div>
      <div className="text-gray-500">
        平均ER {d.avgEr}% ／ 平均閲覧 {d.avgViews.toLocaleString()} ／ {d.count}投稿
      </div>
    </div>
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
    <div className="max-w-[220px] rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow">
      <div className="line-clamp-2 text-gray-700">{d.text || "（本文なし）"}</div>
      <div className="mt-1 text-gray-500">
        閲覧 {d.views.toLocaleString()} ／ ER {d.er}%
      </div>
      <div className="mt-0.5 text-blue-500">クリックで投稿を開く</div>
    </div>
  );
}

export default function AnalyticsPage({ accountId, accounts, onAccountChange }: Props) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [activePie, setActivePie] = useState(0);
  const [period, setPeriod] = useState("all");
  const [exportingTop, setExportingTop] = useState(false);
  // スプレッドシート連携
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [sheetConfigured, setSheetConfigured] = useState(false);
  const [showSheetSetup, setShowSheetSetup] = useState(false);
  const [sheetUrlInput, setSheetUrlInput] = useState("");
  const [savingSheet, setSavingSheet] = useState(false);
  const [sendingSheet, setSendingSheet] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!accountId) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const days = PERIODS.find((p) => p.key === period)?.days ?? null;
      let q = `accountId=${accountId}&t=${Date.now()}`;
      if (days) {
        const from = new Date(Date.now() - days * 86400000).toISOString();
        q += `&from=${encodeURIComponent(from)}`;
      }
      const r = await fetch(`/api/insights?${q}`, { cache: "no-store" });
      setData(r.ok ? await r.json() : null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [accountId, period]);

  useEffect(() => {
    load();
  }, [load]);

  // スプレッドシート連携の設定状況を読み込む（アカウント切替ごと）
  useEffect(() => {
    if (!accountId) {
      setSheetUrl(null);
      setSheetConfigured(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/insights/export-sheet?accountId=${accountId}`, {
          cache: "no-store",
        });
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;
        setSheetUrl(d.url ?? null);
        setSheetConfigured(!!d.configured);
      } catch {
        /* 連携未設定として扱う */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function saveSheetUrl() {
    if (!accountId || savingSheet) return;
    setSavingSheet(true);
    setMsg("スプレッドシートに接続中…");
    try {
      const r = await fetch("/api/insights/export-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, mode: "save", url: sheetUrlInput }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(d.error || "保存に失敗しました。");
        return;
      }
      setSheetUrl(d.url);
      setSheetConfigured(true);
      setShowSheetSetup(false);
      setMsg("スプレッドシート連携を設定しました。「スプレッドシートに送る」で書き込めます。");
    } catch (e) {
      setMsg(`保存に失敗しました: ${String(e)}`);
    } finally {
      setSavingSheet(false);
    }
  }

  async function sendToSheet() {
    if (!accountId || sendingSheet) return;
    if (!sheetConfigured) {
      setSheetUrlInput(sheetUrl ?? "");
      setShowSheetSetup(true);
      return;
    }
    setSendingSheet(true);
    setMsg("スプレッドシートに書き込み中…");
    try {
      const r = await fetch("/api/insights/export-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(d.error || "書き込みに失敗しました。");
        return;
      }
      setMsg(`スプレッドシートの「${d.sheet}」に上位${d.written}件を書き込みました。`);
    } catch (e) {
      setMsg(`書き込みに失敗しました: ${String(e)}`);
    } finally {
      setSendingSheet(false);
    }
  }

  async function refresh(mode: "recent" | "backfill") {
    if (!accountId || refreshing) return;
    setRefreshing(true);
    setMsg(mode === "backfill" ? "過去分を含めて取得中…（時間がかかります）" : "最新の数値を取得中…");
    try {
      const r = await fetch("/api/insights/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, mode }),
      });
      const d = await r.json();
      if (d.degraded) {
        setMsg("このアカウントのトークンには分析(insights)の権限がありません。投稿実績のみ表示します。");
      } else if (d.error) {
        setMsg(`取得に失敗しました: ${d.error}`);
      } else {
        setMsg(`取得完了：${d.fetched}件を分析に反映しました（うちアプリ内投稿の更新${d.postsUpdated}件）`);
      }
      await load();
    } catch (e) {
      setMsg(`取得に失敗しました: ${String(e)}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function importCsvFile(file: File) {
    if (!accountId) {
      setMsg("先にアカウントを選択してください。");
      return;
    }
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      setMsg("CSVファイル（.csv）を選んでください。");
      return;
    }
    setImporting(true);
    setMsg(`CSVを取り込み中…（${file.name}）`);
    try {
      const csvText = await file.text();
      const r = await fetch("/api/insights/import-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, csvText }),
      });
      const d = await r.json();
      if (d.error) {
        setMsg(`取り込み失敗: ${d.error}`);
      } else {
        setMsg(`取り込み完了：解析${d.parsed}件（このアカウントの履歴 合計${d.totalForAccount}件）`);
      }
      await load();
    } catch (err) {
      setMsg(`取り込み失敗: ${String(err)}`);
    } finally {
      setImporting(false);
    }
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await importCsvFile(file);
    if (fileRef.current) fileRef.current.value = "";
  }

  function onDropCsv(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    const csv =
      files.find((f) => /\.csv$/i.test(f.name) || f.type === "text/csv") ?? files[0];
    if (csv) importCsvFile(csv);
  }

  async function toKnowledge(p: LabeledPost) {
    if (!accountId) return;
    const labelJa = p.label === "engage" ? "エンゲージ型" : "リーチ型";
    const dateStr = p.postedAt ? new Date(p.postedAt).toLocaleDateString("ja-JP") : "";
    const ok = window.confirm(
      `この投稿を「${labelJa}」の高パフォ事例として、このアカウントの生成ナレッジに追加します。\n\n${p.text.slice(0, 120)}…\n\n追加しますか？`
    );
    if (!ok) return;
    try {
      // ツリー投稿は各コマが別行で出るため、全文（ツリー全体）を解決してから登録する。
      // 失敗時は従来どおり単体テキストにフォールバック（壊さない）。
      let fullText = p.text;
      try {
        const tr = await fetch("/api/insights/thread-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId, key: p.key, source: p.source }),
        });
        if (tr.ok) {
          const d = await tr.json();
          if (d && typeof d.text === "string" && d.text.trim()) fullText = d.text;
        }
      } catch {
        /* フォールバック維持 */
      }
      const r = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          type: "custom",
          title: `高パフォ投稿(${labelJa}) ${dateStr}｜閲覧${p.views}/ER${p.er}%`,
          content: fullText,
        }),
      });
      if (r.ok) {
        setMsg("生成ナレッジに追加しました（設定→ナレッジで確認できます）");
      } else {
        const d = await r.json().catch(() => ({}));
        setMsg(`ナレッジ追加に失敗: ${d.error || r.status}`);
      }
    } catch (e) {
      setMsg(`ナレッジ追加に失敗: ${String(e)}`);
    }
  }

  // トップ投稿（上位15件）をCSV出力（Excel/スプレッドシートで開ける形式・ツリー全文付き）
  async function exportTopPostsCsv() {
    if (!data || !accountId) return;
    setExportingTop(true);
    setMsg("CSVを作成中…");
    try {
      const top = data.topPosts.slice(0, 15);
      const rows: string[][] = [
        ["順位", "投稿日", "投稿文（ツリー全文）", "表示回数", "いいね数", "返信数", "ER(%)", "投稿URL"],
      ];
      for (let i = 0; i < top.length; i++) {
        const p = top[i];
        let text = p.text;
        try {
          const tr = await fetch("/api/insights/thread-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId, key: p.key, source: p.source }),
          });
          if (tr.ok) {
            const d = await tr.json();
            if (d && typeof d.text === "string" && d.text.trim()) text = d.text;
          }
        } catch {
          /* フォールバック: 単体テキストのまま */
        }
        rows.push([
          String(i + 1),
          p.postedAt ? new Date(p.postedAt).toLocaleDateString("ja-JP") : "",
          text,
          String(p.views),
          String(p.likes),
          String(p.replies),
          String(p.er),
          p.postUrl || "",
        ]);
      }
      const csv = rows.map((r) => r.map(csvEscapeField).join(",")).join("\r\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `top15_${data.accountName}_${dateStr}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMsg(`トップ${top.length}件をCSVに出力しました。スプレッドシートで開けます。`);
    } catch (e) {
      setMsg(`CSV出力に失敗しました: ${String(e)}`);
    } finally {
      setExportingTop(false);
    }
  }

  // 投稿ステータス内訳の代わりに「エンゲージの内訳（何で反応されているか）」を出す
  const engagementData = data
    ? [
        { name: "いいね", value: data.totals.likes, color: C.indigo },
        { name: "返信", value: data.totals.replies, color: C.violet },
        { name: "リポスト", value: data.totals.reposts, color: C.blue },
        { name: "引用", value: data.totals.quotes, color: C.cyan },
      ].filter((d) => d.value > 0)
    : [];

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";
  const fmtMD = (iso: string | null) =>
    iso ? `${new Date(iso).getMonth() + 1}/${new Date(iso).getDate()}` : "—";
  const rangeText = data?.availableRange?.from
    ? `${fmtMD(data.availableRange.from)}〜${fmtMD(data.availableRange.to)}`
    : null;
  // 選択期間に「閲覧データのある投稿」が0件 → 空状態（全期間表示時は出さない）
  const periodEmpty = !!data && period !== "all" && !data.degraded && data.totals.withInsights === 0;

  return (
    <div className="min-w-[720px] flex-1 overflow-y-auto bg-gradient-to-b from-[#fafbfd] to-[#eaeef4]">
      {/* ヘッダー */}
      <div className="px-8 pt-6 pb-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold tracking-tight text-slate-900">分析</h2>
          <select
            value={accountId ?? ""}
            onChange={(e) => onAccountChange(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs shadow-sm">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                  period === p.key
                    ? "bg-slate-900 text-white"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refresh("recent")}
            disabled={refreshing || !accountId}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ background: C.sky }}
          >
            {refreshing ? "取得中…" : "最新を取得"}
          </button>
          <button
            onClick={() => refresh("backfill")}
            disabled={refreshing || !accountId}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            title="過去の投稿までさかのぼってInsightsを取得します（時間がかかります）"
          >
            過去分も取得
          </button>
          <button
            onClick={() => setShowImportModal(true)}
            disabled={importing || !accountId}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            title="スプシ分析ツールのCSVを取り込んで過去データを引き継ぎます"
          >
            {importing ? "取込中…" : "CSV取込"}
          </button>
        </div>
      </div>

      {rangeText && (
        <p className="-mt-2 px-8 pb-2 text-xs text-slate-400">
          データ範囲: {rangeText}
        </p>
      )}

      {msg && (
        <div className="mx-8 mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-800">
          {msg}
        </div>
      )}

      {data?.degraded && (
        <div className="mx-8 mb-4 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800 leading-relaxed">
          ⚠️ <b>このアカウントのトークンには分析(insights)の権限がありません。</b>
          実数値（閲覧・いいね等）は表示できないため、投稿実績のみ表示しています。
          実数値を見るには、Insights権限付きでアクセストークンを取り直し、「設定 → アカウント編集 → アクセストークン」を更新してください。
        </div>
      )}

      {!accountId && (
        <p className="px-8 text-sm text-slate-400">アカウントを選択してください。</p>
      )}

      {loading && !data && (
        <div className="space-y-6 px-8 pb-10">
          <div className="grid grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card-elevated h-[92px] animate-pulse rounded-2xl" />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-6">
            <div className="card-elevated h-[300px] animate-pulse rounded-2xl" />
            <div className="card-elevated h-[300px] animate-pulse rounded-2xl" />
          </div>
          <div className="card-elevated h-[280px] animate-pulse rounded-2xl" />
        </div>
      )}

      {data && periodEmpty && (
        <div className="px-8 pb-10">
          <div className="card-elevated flex flex-col items-center justify-center gap-3 rounded-2xl px-6 py-16 text-center">
            <span className="text-3xl">🗓️</span>
            <p className="text-sm font-semibold text-slate-700">
              選択中の期間（{periodLabel}）に投稿データがありません
            </p>
            <p className="text-xs text-slate-500">
              {rangeText
                ? `このアカウントのデータは ${rangeText} 分があります。期間を広げてください。`
                : "期間を広げるか、「最新を取得」してください。"}
            </p>
            <button
              onClick={() => setPeriod("all")}
              className="mt-1 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
              style={{ background: C.indigo }}
            >
              全期間を表示
            </button>
          </div>
        </div>
      )}

      {data && !periodEmpty && (
        <div className="px-8 pb-10 space-y-6">
          {/* サマリカード */}
          <div className="grid grid-cols-4 gap-4">
            <Card label="投稿数（実績）" value={data.totals.posts} />
            {!data.degraded && (
              <>
                <Card label="合計閲覧" value={data.totals.views} color={C.sky} />
                <Card label="平均閲覧/投稿" value={data.totals.avgViews} color={C.sky} />
                <Card label="平均ER" value={data.totals.avgEr} decimals={2} suffix="%" color={C.indigo} />
              </>
            )}
          </div>

          {!data.degraded && (
            <div className="grid grid-cols-4 gap-4">
              <Card label="いいね" value={data.totals.likes} color={C.indigo} />
              <Card label="返信" value={data.totals.replies} color={C.violet} />
              <Card label="リポスト" value={data.totals.reposts} color={C.blue} />
              <Card label="引用" value={data.totals.quotes} color={C.cyan} />
            </div>
          )}

          {!data.degraded && (
            <p className="text-xs text-slate-400">
              基準値（成長追従）: P80閲覧 = {data.p80Views.toLocaleString()} / P80_ER = {data.p80Er}% / ナレッジ閾値 ={" "}
              {data.threshold.toLocaleString()} 閲覧。最終取得:{" "}
              {data.insightsLastFetchedAt
                ? new Date(data.insightsLastFetchedAt).toLocaleString("ja-JP")
                : "未取得"}
              {data.historicalCount > 0 && ` ／ CSV履歴 ${data.historicalCount}件`}
            </p>
          )}

          {/* グラフ群 */}
          <div className="grid grid-cols-2 gap-6">
            {/* エンゲージの内訳（ステータス内訳の置き換え） */}
            <ChartBox title="エンゲージの内訳（何で反応されているか）">
              {data.degraded ? (
                <Degraded />
              ) : engagementData.length === 0 ? (
                <Empty />
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={engagementData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={52}
                      outerRadius={86}
                      paddingAngle={3}
                      stroke="#ffffff"
                      strokeWidth={3}
                      activeIndex={activePie}
                      activeShape={renderActiveSlice}
                      onMouseEnter={(_, i) => setActivePie(i)}
                    >
                      {engagementData.map((s) => (
                        <Cell key={s.name} fill={s.color} />
                      ))}
                    </Pie>
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </ChartBox>

            {/* 時刻別 平均ER（0〜23時） */}
            <ChartBox title="時刻別 平均ER（0〜23時・JST）">
              {data.degraded ? (
                <Degraded />
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={data.hourly} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                    <defs>
                      <linearGradient id="barIndigo" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.indigo} stopOpacity={0.95} />
                        <stop offset="100%" stopColor={C.indigo} stopOpacity={0.45} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis
                      dataKey="hour"
                      tick={{ fontSize: 10, fill: C.axis }}
                      axisLine={false}
                      tickLine={false}
                      interval={1}
                      tickFormatter={(h) => `${h}`}
                    />
                    <YAxis tick={{ fontSize: 11, fill: C.axis }} axisLine={false} tickLine={false} width={36} />
                    <Tooltip content={<HourTooltip />} cursor={{ fill: "rgba(99,102,241,0.06)" }} />
                    <Bar dataKey="avgEr" fill="url(#barIndigo)" radius={[4, 4, 0, 0]} name="平均ER(%)" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartBox>
          </div>

          {/* 時系列 */}
          <ChartBox title="日別 閲覧数とER">
            {data.degraded ? (
              <Degraded />
            ) : data.timeSeries.length === 0 ? (
              <Empty />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={data.timeSeries} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                  <defs>
                    <linearGradient id="areaViews" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.sky} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={C.sky} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: C.axis }} axisLine={false} tickLine={false} minTickGap={28} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11, fill: C.axis }} axisLine={false} tickLine={false} width={44} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: C.axis }} axisLine={false} tickLine={false} width={36} />
                  <Tooltip />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  <Area yAxisId="left" type="monotone" dataKey="views" stroke={C.sky} strokeWidth={2.5} fill="url(#areaViews)" name="閲覧" />
                  <Line yAxisId="right" type="monotone" dataKey="er" stroke={C.indigo} strokeWidth={2.5} name="ER(%)" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </ChartBox>

          {/* エンゲージ分布（散布図） */}
          {!data.degraded && data.distribution.length > 0 && (
            <ChartBox title="エンゲージ分布（横:閲覧 × 縦:ER% ／ 点をクリックで投稿を開く）">
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: C.indigo }} />
                  エンゲージ型（高閲覧×高ER）
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: C.sky }} />
                  リーチ型（高閲覧×並ER）
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: C.neutral }} />
                  その他（閾値 {data.threshold.toLocaleString()}閲覧 未満）
                </span>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <ScatterChart margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke={C.grid} />
                  <XAxis type="number" dataKey="views" name="閲覧" tick={{ fontSize: 11, fill: C.axis }} axisLine={false} tickLine={false} />
                  <YAxis type="number" dataKey="er" name="ER(%)" tick={{ fontSize: 11, fill: C.axis }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip cursor={{ strokeDasharray: "3 3" }} content={<ScatterTooltip />} />
                  <Scatter
                    name="投稿"
                    data={data.distribution}
                    cursor="pointer"
                    onClick={(node) => {
                      const url = (node as unknown as { postUrl?: string | null })?.postUrl;
                      if (url) window.open(url, "_blank", "noopener");
                    }}
                  >
                    {data.distribution.map((d, i) => (
                      <Cell
                        key={i}
                        fillOpacity={0.85}
                        fill={d.label === "engage" ? C.indigo : d.label === "reach" ? C.sky : C.neutral}
                      />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </ChartBox>
          )}

          {/* トップ投稿ランキング */}
          {!data.degraded && data.topPosts.length > 0 && (
            <div className="overflow-hidden rounded-2xl card-elevated">
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
                <h3 className="text-[13px] font-semibold text-slate-700">トップ投稿（閲覧順）</h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={sendToSheet}
                    disabled={sendingSheet}
                    className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
                    style={{ background: "#16a34a" }}
                    title="上位15件をツリー全文・表示回数・いいね数つきでGoogleスプレッドシートに自動書き込みします"
                  >
                    {sendingSheet
                      ? "送信中…"
                      : sheetConfigured
                      ? "📤 スプレッドシートに送る"
                      : "📤 スプレッドシート連携を設定"}
                  </button>
                  {sheetConfigured && (
                    <button
                      onClick={() => {
                        setSheetUrlInput(sheetUrl ?? "");
                        setShowSheetSetup(true);
                      }}
                      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50"
                      title="連携先スプレッドシートのURLを変更する"
                    >
                      ⚙ 連携先
                    </button>
                  )}
                  <button
                    onClick={exportTopPostsCsv}
                    disabled={exportingTop}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
                    title="上位15件をツリー全文・閲覧数・いいね数つきでCSV出力します（スプレッドシートで開けます）"
                  >
                    {exportingTop ? "出力中…" : "📊 CSV出力"}
                  </button>
                </div>
              </div>
              <div className="divide-y divide-slate-100">
                {data.topPosts.slice(0, 15).map((p, i) => {
                  const maxViews = data.topPosts[0]?.views || 1;
                  const barPct = Math.max(3, Math.round((p.views / maxViews) * 100));
                  const highEr = p.er >= data.p80Er;
                  return (
                    <div
                      key={p.key}
                      className="relative flex items-center px-5 py-3.5 transition-colors hover:bg-slate-50/60"
                    >
                      {/* 閲覧量の比例バー（行の背景＝一目でランキングが分かる） */}
                      <div
                        className="pointer-events-none absolute inset-y-2 left-0 rounded-r-lg"
                        style={{
                          width: `${barPct}%`,
                          background:
                            "linear-gradient(90deg, rgba(99,102,241,0.13), rgba(14,165,233,0.04))",
                        }}
                      />
                      <div className="relative z-10 flex w-full items-center gap-3.5">
                        <RankBadge rank={i + 1} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-800">
                            {p.text || "（本文なし）"}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                            <Metric icon={<EyeIcon />} value={p.views.toLocaleString()} color="#0284c7" />
                            <Metric icon={<HeartIcon />} value={p.likes.toLocaleString()} color="#f43f5e" />
                            <Metric icon={<ChatIcon />} value={p.replies.toLocaleString()} color="#8b5cf6" />
                            <span
                              className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums"
                              style={{
                                background: highEr ? "#ecfdf5" : "#f1f5f9",
                                color: highEr ? "#059669" : "#64748b",
                              }}
                            >
                              ER {p.er}%
                            </span>
                            {p.postedAt && (
                              <span className="text-xs text-slate-400">
                                {new Date(p.postedAt).toLocaleDateString("ja-JP")}
                              </span>
                            )}
                          </div>
                        </div>
                        {p.label && <LabelBadge label={p.label} />}
                        {p.postUrl && (
                          <a
                            href={p.postUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 text-xs font-medium text-sky-600 hover:underline"
                          >
                            開く ↗
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 高パフォ投稿（ナレッジ候補） */}
          {!data.degraded && (
            <div className="overflow-hidden rounded-2xl card-elevated">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
                <h3 className="text-[13px] font-semibold text-slate-700">
                  高パフォ投稿（ナレッジ候補）{data.labeledPosts.length}件
                </h3>
                <span className="text-xs text-slate-400">エンゲージ型 / リーチ型を生成ナレッジに手動で追加できます</span>
              </div>
              {data.labeledPosts.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-400">
                  まだ閾値（{data.threshold.toLocaleString()}閲覧）を超える投稿がありません。
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {data.labeledPosts.slice(0, 30).map((p) => (
                    <div
                      key={p.key}
                      className="flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-slate-50/70"
                    >
                      <LabelBadge label={p.label} />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 whitespace-pre-wrap text-sm text-slate-800">{p.text}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <Metric icon={<EyeIcon />} value={p.views.toLocaleString()} color="#0284c7" />
                          <Metric icon={<HeartIcon />} value={p.likes.toLocaleString()} color="#f43f5e" />
                          <span
                            className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums"
                            style={{
                              background: p.er >= data.p80Er ? "#ecfdf5" : "#f1f5f9",
                              color: p.er >= data.p80Er ? "#059669" : "#64748b",
                            }}
                          >
                            ER {p.er}%
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => toKnowledge(p)}
                        className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
                        style={{ background: C.indigo }}
                      >
                        ナレッジ化
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showSheetSetup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowSheetSetup(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">スプレッドシート連携の設定</h3>
              <button
                onClick={() => setShowSheetSetup(false)}
                className="text-xl leading-none text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-slate-500">
              書き込み先のGoogleスプレッドシートに、専用の連携を1回だけ設定します。設定後は「スプレッドシートに送る」ボタンで、表示回数の上位15位（ツリー全文・表示回数・いいね数つき）が自動で書き込まれます。
            </p>
            <ol className="mb-3 list-decimal space-y-1 rounded-lg bg-slate-50 px-5 py-3 text-xs leading-relaxed text-slate-600">
              <li>書き込みたいスプレッドシートを開く</li>
              <li>メニュー「拡張機能」→「Apps Script」を開く</li>
              <li>
                フォルダ内 <b>gas/analytics-export.gs</b> の中身を全部貼り付けて保存（不明なら担当に「連携コードを出して」と言えば出します）
              </li>
              <li>「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」／実行者「自分」／アクセス「全員」→ デプロイ（初回は承認を許可）</li>
              <li>表示された<b>ウェブアプリのURL</b>をコピーして、下に貼り付け</li>
            </ol>
            <input
              type="text"
              value={sheetUrlInput}
              onChange={(e) => setSheetUrlInput(e.target.value)}
              placeholder="https://script.google.com/macros/s/●●●/exec"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 focus:border-emerald-400 focus:outline-none"
            />
            {msg && (
              <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                {msg}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowSheetSetup(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
              >
                閉じる
              </button>
              <button
                onClick={saveSheetUrl}
                disabled={savingSheet || !sheetUrlInput.trim()}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: "#16a34a" }}
              >
                {savingSheet ? "接続中…" : "接続して保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showImportModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowImportModal(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">CSVを取り込む</h3>
              <button
                onClick={() => setShowImportModal(false)}
                className="text-xl leading-none text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>
            <p className="mb-3 text-xs text-slate-500">
              CSVの列は<b>見出し名から自動で認識</b>します（順番が違っても・列名が多少ブレてもOK。スプシ分析ツールのCSVに最適化）。選択中のアカウント「
              <b>
                {data?.accountName ??
                  accounts.find((a) => a.id === accountId)?.name ??
                  "—"}
              </b>
              」の履歴として取り込みます。
            </p>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={onDropCsv}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
                dragging
                  ? "border-sky-400 bg-sky-50"
                  : "border-slate-300 bg-slate-50 hover:border-slate-400"
              }`}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={onImportFile}
              />
              <span className="text-3xl">📊</span>
              {importing ? (
                <span className="text-sm font-medium text-sky-600">取り込み中…</span>
              ) : (
                <>
                  <span className="text-sm font-medium text-slate-700">
                    ここにCSVをドラッグ&ドロップ
                  </span>
                  <span className="text-xs text-slate-400">
                    またはクリックしてファイルを選択
                  </span>
                </>
              )}
            </label>
            {msg && (
              <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                {msg}
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setShowImportModal(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10Z" />
    </svg>
  );
}

function Metric({ icon, value, color }: { icon: React.ReactNode; value: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span style={{ color }} className="flex items-center">
        {icon}
      </span>
      <span className="font-semibold tabular-nums text-slate-700">{value}</span>
    </span>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const top = rank <= 3;
  const topBg = ["#6366f1", "#8b8ff5", "#b7b9fa"][rank - 1];
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums"
      style={
        top
          ? { background: topBg, color: "#fff", boxShadow: "0 1px 3px rgba(99,102,241,0.4)" }
          : { background: "#f1f5f9", color: "#94a3b8" }
      }
    >
      {rank}
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
  const display = decimals > 0 ? n.toFixed(decimals) : Math.round(n).toLocaleString();
  return (
    <div className="card-elevated is-hoverable rounded-2xl p-5">
      <div className="mb-2 flex items-center gap-1.5">
        {color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      </div>
      <p className="text-[26px] font-bold leading-none tracking-tight tabular-nums text-slate-900">
        {display}
        {suffix}
      </p>
    </div>
  );
}

function ChartBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl card-elevated p-5">
      <h3 className="mb-4 text-[13px] font-semibold text-slate-700">{title}</h3>
      {children}
    </div>
  );
}

function LabelBadge({ label }: { label: "engage" | "reach" | null }) {
  if (!label) return null;
  const isEngage = label === "engage";
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{
        background: isEngage ? "#eef2ff" : "#e0f2fe",
        color: isEngage ? "#4f46e5" : "#0284c7",
      }}
    >
      {isEngage ? "エンゲージ型" : "リーチ型"}
    </span>
  );
}

// CSVフィールドのエスケープ（カンマ・改行・"を含む場合のみ引用符で囲む。RFC4180準拠）
function csvEscapeField(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function Empty() {
  return (
    <div className="flex h-[240px] items-center justify-center text-sm text-slate-300">
      データがありません
    </div>
  );
}
function Degraded() {
  return (
    <div className="flex h-[240px] items-center justify-center text-sm text-slate-300">
      insights権限がないため表示できません
    </div>
  );
}
