import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { parsePosts } from "@/lib/post-parser";
import {
  describeClaudeCliError,
  estimateClaudeGenerationTimeoutMs,
  getClaudeUsageStatus,
  recordClaudeUsageLimitError,
  runClaude,
  type ClaudeCliError,
} from "@/lib/claude-cli";
import {
  buildRecommendedPostingPlan,
} from "@/lib/recommended-times";
import { computeAccountBestHours } from "@/lib/insights/best-hours";
import {
  dailyPostCountFromPostingHours,
  MAX_GENERATE_POSTS,
  normalizeAccountPostingHours,
} from "@/lib/account-posting";
import {
  buildDiversityPlan,
  buildDiversityPromptSection,
  groupHistoricalPosts,
  filterSimilarPosts,
  type HistoricalPost,
} from "@/lib/generation-diversity";

// 類似回避のために参照する「直近の投稿」の最大件数
const DIVERSITY_RECENT_LIMIT = 120;

/**
 * AI投稿生成エンドポイント（Claude Code CLI版 — サブスク範囲内）
 * POST body: { accountId, count: number }
 */
export async function POST(request: Request) {
  try {
    const { accountId, count, extraInstructions } = await request.json();
    const extra =
      typeof extraInstructions === "string" ? extraInstructions.trim() : "";

    if (!accountId) {
      return NextResponse.json(
        { error: "accountId required" },
        { status: 400 }
      );
    }

    // アカウント情報取得
    const account = await prisma.account.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      return NextResponse.json(
        { error: "アカウントが見つかりません" },
        { status: 404 }
      );
    }

    if (!account.conceptSheet) {
      return NextResponse.json(
        { error: "コンセプトシートが未設定です。設定画面から入力してください。" },
        { status: 400 }
      );
    }

    // ナレッジ取得（アカウント固有 + 共通、enabled=true のみ）
    const knowledges = await prisma.knowledge.findMany({
      where: {
        AND: [
          { OR: [{ accountId }, { accountId: null }] },
          { enabled: true },
        ],
      },
      orderBy: [{ type: "asc" }, { sortOrder: "asc" }],
    });

    const rulesKnowledge = knowledges.find((k) => k.type === "rules");
    const structuresKnowledge = knowledges.find((k) => k.type === "structures");
    const customKnowledges = knowledges.filter((k) => k.type === "custom");

    // 投稿時間帯。1日分の生成本数は、この時間帯の数を正とする。
    const postingHours = normalizeAccountPostingHours(account.postingHours);

    const defaultCount = dailyPostCountFromPostingHours(account.postingHours);
    const wantCount = Math.max(
      1,
      Math.min(MAX_GENERATE_POSTS, Number(count) || defaultCount)
    );

    const usage = getClaudeUsageStatus();
    if (usage.maxRecommendedPosts === 0) {
      return NextResponse.json(
        {
          error:
            `${usage.title}\n${usage.message}\n${usage.nextAction}`,
          usage,
        },
        { status: 429 }
      );
    }
    if (
      typeof usage.maxRecommendedPosts === "number" &&
      wantCount > usage.maxRecommendedPosts
    ) {
      return NextResponse.json(
        {
          error:
            `${usage.title}\n${usage.message}\n${usage.nextAction}\n\n今回は${usage.maxRecommendedPosts}投稿以下に減らしてください。`,
          usage,
        },
        { status: 429 }
      );
    }

    // 類似回避・投稿タイプローテーション用に、直近の投稿を取得してグルーピング
    const recentRaw = await prisma.post.findMany({
      where: { accountId },
      select: { groupNo: true, body: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: DIVERSITY_RECENT_LIMIT,
    });
    const historicalPosts: HistoricalPost[] = groupHistoricalPosts(
      recentRaw.map((p) => ({
        groupNo: p.groupNo ?? 0,
        body: p.body,
        createdAt: p.createdAt,
      }))
    );
    const diversityPlan = buildDiversityPlan(wantCount, historicalPosts.length);
    const diversitySection = buildDiversityPromptSection(
      diversityPlan,
      historicalPosts
    );

    // プロンプト構築
    const prompt = buildPrompt(
      account.conceptSheet,
      rulesKnowledge?.content || "",
      structuresKnowledge?.content || "",
      customKnowledges.map((k) => k.content),
      postingHours,
      wantCount,
      extra,
      diversitySection
    );
    const timeoutMs = estimateClaudeGenerationTimeoutMs({
      promptChars: prompt.length,
      count: wantCount,
    });

    // Claude CLI 実行（サブスク範囲内 / プロンプトは stdin 経由で渡す）
    let generatedText: string;
    try {
      generatedText = await runClaude(prompt, { timeoutMs });
    } catch (e: unknown) {
      const err = e as ClaudeCliError;
      const rawDetail = `${err.stderr || ""}\n${err.stdout || ""}\n${err.message || ""}`.trim();
      recordClaudeUsageLimitError(rawDetail);
      console.error("Claude CLI error:", rawDetail);
      return NextResponse.json(
        {
          error: describeClaudeCliError(rawDetail, err),
          detail: rawDetail.slice(0, 800),
        },
        { status: 502 }
      );
    }

    if (!generatedText) {
      return NextResponse.json(
        {
          error:
            "Claudeからの応答が空でした。もう一度試すか、ターミナルで `claude /login` を実行してログイン状態を確認してください。",
        },
        { status: 502 }
      );
    }

    // パースしてDBに保存
    const posts = parsePosts(generatedText, wantCount);
    if (posts.length === 0) {
      return NextResponse.json(
        {
          error:
            "AIの出力を投稿に分割できませんでした。出力フォーマットが崩れた可能性があります。もう一度「生成開始」を押してみてください。",
          detail: generatedText.slice(0, 500),
        },
        { status: 500 }
      );
    }

    // 類似チェック：過去投稿・同一バッチ内で似すぎた投稿は保存しない
    const { kept, skipped } = filterSimilarPosts(
      posts,
      diversityPlan,
      historicalPosts
    );
    const finalPosts = kept.map((k) => k.post);
    const skippedSimilar = skipped.length;
    if (finalPosts.length === 0) {
      return NextResponse.json(
        {
          error:
            "生成した投稿がすべて過去の投稿と似すぎていたため、保存をスキップしました。もう一度生成するか、「追加指示」で別の場面・悩み・結論を指定してください。",
        },
        { status: 422 }
      );
    }

    // 最大groupNoとsortOrderを取得
    const [maxGroup, maxSort] = await Promise.all([
      prisma.post.aggregate({
        where: { accountId },
        _max: { groupNo: true },
      }),
      prisma.post.aggregate({
        where: { accountId },
        _max: { sortOrder: true },
      }),
    ]);

    let groupNo = (maxGroup._max.groupNo ?? 0) + 1;
    let sortOrder = (maxSort._max.sortOrder ?? 0) + 1;

    // 実データ（時間別パフォーマンス）から推奨枠を割り出す。失敗時はnull→従来ルールにフォールバック。
    const preferred = await computeAccountBestHours(accountId, postingHours).catch(
      () => null
    );

    const recommendations = buildRecommendedPostingPlan(
      account.conceptSheet,
      postingHours,
      finalPosts.length,
      { postTexts: finalPosts.map((post) => post.items.join("\n\n")), preferred }
    );

    const dbData = [];
    for (const [index, post] of finalPosts.entries()) {
      const recommendation = recommendations[index];
      const recommendationData = recommendation
        ? {
            recommendedHour: recommendation.hour,
            recommendedLabel: recommendation.label,
            recommendedReason: recommendation.reason,
          }
        : {};
      if (post.thread && post.items.length > 1) {
        for (const item of post.items) {
          dbData.push({
            accountId,
            groupNo,
            body: item,
            postType: "thread",
            charCount: item.length,
            status: "draft",
            batchFile: "ai-generate",
            sortOrder: sortOrder++,
            ...recommendationData,
          });
        }
      } else {
        const body = post.items[0] ?? "";
        dbData.push({
          accountId,
          groupNo,
          body,
          postType: "standalone",
          charCount: body.length,
          status: "draft",
          batchFile: "ai-generate",
          sortOrder: sortOrder++,
          ...recommendationData,
        });
      }
      groupNo++;
    }

    const result = await prisma.post.createMany({ data: dbData });

    return NextResponse.json(
      {
        count: result.count,
        posts: finalPosts.length,
        skippedSimilar,
        recommendations,
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("generate error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ===========================================================
// プロンプト構築
// ===========================================================
function buildPrompt(
  conceptSheet: string,
  rules: string,
  structures: string,
  customKnowledges: string[],
  postingHours: number[],
  count: number,
  extraInstructions: string = "",
  diversitySection: string = ""
): string {
  const parts = [
    "あなたはSNSコンテンツの専門家です。以下のコンセプト定義・ルール・構成パターンに基づき、そのまま投稿できる品質のThreads投稿を生成してください。",
    "",
    "## コンセプトシート（ペルソナ・語彙・テーマ）",
    conceptSheet,
    "",
  ];

  if (diversitySection) {
    parts.push(diversitySection, "");
  }

  if (extraInstructions) {
    parts.push(
      "## 🔴 今回の追加指示（このバッチでのみ最優先で従うこと）",
      "下記はユーザーが今回の生成のために明示的に指定した追加指示です。",
      "コンセプトシート・ナレッジ・生成ルールと矛盾する場合は **この追加指示を優先** すること。",
      "",
      extraInstructions,
      ""
    );
  }

  if (rules) {
    parts.push("## 投稿生成ルール", rules, "");
  }

  if (structures) {
    parts.push("## 投稿構成パターン集", structures, "");
  }

  for (const custom of customKnowledges) {
    parts.push("## 追加ナレッジ", custom, "");
  }

  parts.push(
    "## 品質基準（妥協禁止）",
    "投稿は「型は守れているが既視感がある」状態にならないこと。バズるために以下を厳守：",
    "",
    "### フック（1投稿目）の必須要件",
    "- 既存インフルエンサーが使い古した定型表現を避ける（例: 『2種類の人間がいる』『才能の差じゃない』『悪いこと言わないから』『断言します』『あなたの努力が報われないのは〜だけ』など、Threads上で過去30日に頻出するパターンは使用禁止）",
    "- 業界内の固有名詞だけで完結させない（例: 稼ぐ系で『楽天アフィvs退職代行』のような比較だけで終わらせない）。業界外からのアナロジー・比喩を1本に1つは含めること",
    "- 数字を入れるなら『個人的な実績数字』『具体的な固有名詞』を優先（一般論の数字より遥かに強い）",
    "- 結論の予測がつく定型ロジックで埋めない。1行目で予想を裏切る切り口を1つ仕込む",
    "",
    "### 表現の制約",
    "- AI感のある表現禁止: **太字**、【見出し】、箇条書き連発、過度に整った論理展開",
    "- ですます調とタメ口の混在で生っぽさを出す",
    "- 接続詞は口語化（『また』→『あと』、『しかし』→『でも』、『さらに』→『で、』）",
    "- 結論や本題を匂わせて未完了で終わる『、』止めを活用",
    "",
    "### 反復回避",
    "- 1バッチ内で同じフック型を2回使わない",
    "- 1バッチ内で同じテーマカテゴリを3回以上使わない",
    "- 同じ語尾・同じ句読点リズムを連続させない",
    "",
    "## 生成指示",
    `- ${count}本のスレッド投稿（ツリー投稿）を生成する。**全件スレッド型で出力すること。単体投稿は1本も含めない。**`,
    `- 投稿時間帯の候補: ${postingHours.map((h) => `${h}時`).join("、")}`,
    "- 投稿時間帯のおすすめ表示はアプリ側で自動計算するため、本文中には時刻や予約案内を書かない",
    "- 各スレッドは **2投稿（基本）または3投稿（深い話・ステップ系のみ）** で構成する。**4投稿以上は厳禁**（読者離脱率が急増し、API側のリプライ伝播ラグで投稿失敗率も上がるため）",
    "- 2投稿型: ■1 フック＋橋渡し / ■2 本編＋締め（CTAあれば最後に自然に溶け込ませる）",
    "- 3投稿型: ■1 フック / ■2 本編 / ■3 締め＋CTA",
    "- 各投稿（1スレッド内の各リプライ）は200〜500字",
    "- 1バッチ内で同じフック型・同じ構成パターンを2回使わない",
    "",
    "## 出力フォーマット（絶対厳守 — この通りに、本文だけを出力）",
    "前置き・あいさつ・説明・採点・コードブロック（```）は一切出力しないこと。下記の形をそのまま守ること：",
    "",
    "■1",
    "（1スレッド目の1投稿目の本文。フック＋橋渡し。200〜500字）",
    "",
    "■2",
    "（1スレッド目の2投稿目の本文。本編＋締め。200〜500字）",
    "",
    "=====",
    "",
    "■1",
    "（2スレッド目の1投稿目の本文）",
    "",
    "■2",
    "（2スレッド目の2投稿目の本文）",
    "",
    "=====",
    "",
    `（…これを合計 ${count} スレッド分くり返す）`,
    "",
    "### フォーマット規則（違反禁止）",
    "- スレッドとスレッドの区切りは、必ず半角イコールを5つ並べた行「=====」だけにする（他の区切り線・見出しは使わない）",
    "- 各投稿の先頭は必ず行頭に「■1」「■2」（深い話のみ「■3」まで）。■4以上は禁止",
    "- 「投稿1:」「スレッド1」「1本目」のような見出しラベルは付けない。■マーカーだけで区切る",
    "- 本文中に **太字**、## 見出し、- や 1. の箇条書き、表 などのマークダウン記法を使わない",
    "- 1スレッドにつき ■マーカーは2個（または3個）。必ず複数の■を含めること",
    `- 最終的に「=====」で区切られたスレッドのかたまりが ${count} 個になるように出力する`
  );

  if (extraInstructions) {
    parts.push(
      "",
      "## 🔴 もう一度: 今回の追加指示（最優先・再掲）",
      "生成を始める前に、もう一度この指示を読み返し、すべての投稿に確実に反映すること:",
      "",
      extraInstructions
    );
  }

  return parts.join("\n");
}
