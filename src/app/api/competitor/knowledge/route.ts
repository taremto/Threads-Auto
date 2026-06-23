import { NextResponse } from "next/server";
import {
  describeClaudeCliError,
  estimateClaudeGenerationTimeoutMs,
  getClaudeUsageStatus,
  recordClaudeUsageLimitError,
  runClaude,
  type ClaudeCliError,
} from "@/lib/claude-cli";

/**
 * 競合分析 → ナレッジ生成エンドポイント（Claude Code CLI / サブスク範囲内）
 *
 * ブラウザ側で集計済みの競合データ（統計＋上位投稿）を受け取り、
 * 投稿生成プロンプトにそのまま注入できる「追加ナレッジ」markdown を返す。
 * DB には一切書き込まない（stateless）。保存は既存 /api/knowledge を使う。
 *
 * POST body: { competitorName, stats, topPosts }
 */

type TimeBand = { band: string; avgEr: number; avgViews: number; count: number };
type HourStat = { hour: number; avgEr: number; avgViews: number; count: number };
type TopPost = {
  rank: number;
  views: number;
  er: number;
  weekday?: string | null;
  hour?: number | null;
  text: string;
};
type Stats = {
  totalPosts: number;
  totalViews: number;
  avgViews: number;
  avgEr: number;
  p80Views: number;
  p80Er: number;
  bestWeekday: string | null;
  timeBands: TimeBand[];
  hourlyTop: HourStat[];
};

export async function POST(request: Request) {
  try {
    const { competitorName, stats, topPosts } = (await request.json()) as {
      competitorName?: string;
      stats?: Stats;
      topPosts?: TopPost[];
    };

    if (!competitorName || !stats) {
      return NextResponse.json(
        { error: "competitorName と stats が必要です。" },
        { status: 400 }
      );
    }

    // 使用量チェック（生成と同じ。完全に枠切れの時だけ止める）
    const usage = getClaudeUsageStatus();
    if (usage.maxRecommendedPosts === 0) {
      return NextResponse.json(
        { error: `${usage.title}\n${usage.message}\n${usage.nextAction}`, usage },
        { status: 429 }
      );
    }

    const prompt = buildCompetitorKnowledgePrompt(
      competitorName,
      stats,
      topPosts || []
    );
    const timeoutMs = estimateClaudeGenerationTimeoutMs({
      promptChars: prompt.length,
      count: 1,
    });

    // Claude CLI 実行（サブスク範囲内 / プロンプトは stdin 経由）
    // model は指定しない＝両バージョンとも既定の opus（高品質）。
    // ※ v1.1.37 の ClaudeRunOptions には model フィールドが無いため、
    //   ここで model を渡すと拡張パック適用時に型エラーになる（v1.1.38 で追加された機能）。
    let knowledge: string;
    try {
      knowledge = await runClaude(prompt, { timeoutMs });
    } catch (e: unknown) {
      const err = e as ClaudeCliError;
      const rawDetail = `${err.stderr || ""}\n${err.stdout || ""}\n${err.message || ""}`.trim();
      recordClaudeUsageLimitError(rawDetail);
      console.error("Competitor knowledge Claude CLI error:", rawDetail);
      return NextResponse.json(
        {
          error: describeClaudeCliError(rawDetail, err),
          detail: rawDetail.slice(0, 800),
        },
        { status: 502 }
      );
    }

    if (!knowledge || !knowledge.trim()) {
      return NextResponse.json(
        {
          error:
            "Claudeからの応答が空でした。もう一度試すか、ターミナルで `claude /login` を実行してログイン状態を確認してください。",
        },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, knowledge: knowledge.trim() });
  } catch (e) {
    console.error("competitor knowledge POST error:", e);
    return NextResponse.json(
      {
        error:
          "ナレッジ生成に失敗しました: " +
          (e instanceof Error ? e.message : String(e)),
      },
      { status: 500 }
    );
  }
}

function buildCompetitorKnowledgePrompt(
  competitorName: string,
  stats: Stats,
  topPosts: TopPost[]
): string {
  const bandLine =
    (stats.timeBands || [])
      .filter((b) => b.count > 0)
      .map((b) => `${b.band}=ER${b.avgEr}%(平均閲覧${b.avgViews})`)
      .join(" / ") || "データ不足";
  const hourLine =
    (stats.hourlyTop || [])
      .map((h) => `${h.hour}時(平均閲覧${h.avgViews}/ER${h.avgEr}%)`)
      .join(" / ") || "データ不足";
  const postLines =
    topPosts
      .map(
        (p) =>
          `- #${p.rank} 閲覧${p.views}/ER${p.er}%${
            p.weekday || p.hour != null
              ? ` [${p.weekday ?? ""}${p.hour != null ? `${p.hour}時` : ""}]`
              : ""
          }\n  「${(p.text || "").replace(/\n/g, " ")}」`
      )
      .join("\n") || "（データなし）";

  return [
    "あなたはSNS(Threads)グロース分析の専門家です。",
    "ある競合アカウントの実データを渡します。これを分析し、私自身の投稿生成AIがそのまま参考にできる「競合分析ナレッジ」を日本語のmarkdownで出力してください。",
    "",
    "## 競合アカウント",
    `- 名前: ${competitorName}`,
    `- 総投稿数: ${stats.totalPosts} / 総閲覧数: ${stats.totalViews} / 平均閲覧: ${stats.avgViews} / 平均ER: ${stats.avgEr}%`,
    `- 上位基準(P80): 閲覧 ${stats.p80Views} / ER ${stats.p80Er}%`,
    `- 最も伸びた曜日: ${stats.bestWeekday ?? "不明"}`,
    `- 時間帯別(平均ER): ${bandLine}`,
    `- よく伸びる時刻トップ: ${hourLine}`,
    "",
    `## 伸びた投稿トップ${topPosts.length}（閲覧数順 / 各: 閲覧・ER・曜日時刻・本文）`,
    postLines,
    "",
    "# 出力してほしいもの（この見出し構成で、簡潔に）",
    "## フック分析",
    "（伸びた投稿の1行目に共通する「型」を3〜5個、具体的な言い回しの例ごと）",
    "## 構成の特徴",
    "（2投稿/3投稿などのツリー構成、長さ、締め・CTAの型など）",
    "## 強いテーマ",
    "（よく伸びているトピック・切り口を箇条書き）",
    "## おすすめ投稿時間帯",
    "（上のデータから、曜日・時間帯の推奨を簡潔に）",
    "## 自分の投稿に活かす指針",
    "（私の生成AIがそのまま使える、3〜6個の具体的な指示）",
    "",
    "注意: 前置き・あいさつ・コードブロック(```)・採点は書かない。本文(markdown)だけを出力すること。競合の固有名詞や本文の丸写しは避け、再現可能な「型」に抽象化すること。",
  ].join("\n");
}
