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
  describeCodexCliError,
  runCodex,
  type CodexCliError,
} from "@/lib/codex-cli";
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

type AiProvider = "auto" | "claude" | "codex";

type FlowPostMetadata = {
  layer: "L1" | "L2" | "L3" | "不明";
  angle: string;
  hook: string;
  structure: string;
  knowledgeRefs: string[];
};

function extractFlowMetadata(raw: string): {
  cleanText: string;
  metadata: Array<FlowPostMetadata | null>;
} {
  const metadata: Array<FlowPostMetadata | null> = [];
  const cleanText = raw
    .replace(
      /^\[\[FLOW_META_(\d+):(\{.*\})\]\]\s*$/gm,
      (_line, rawIndex: string, rawJson: string) => {
        const index = Number(rawIndex) - 1;
        try {
          const parsed = JSON.parse(rawJson) as Record<string, unknown>;
          const rawLayer =
            typeof parsed.layer === "string" ? parsed.layer : "不明";
          const layer =
            rawLayer === "L1" || rawLayer === "L2" || rawLayer === "L3"
              ? rawLayer
              : "不明";
          metadata[index] = {
            layer,
            angle:
              typeof parsed.angle === "string" ? parsed.angle.trim() : "",
            hook: typeof parsed.hook === "string" ? parsed.hook.trim() : "",
            structure:
              typeof parsed.structure === "string"
                ? parsed.structure.trim()
                : "",
            knowledgeRefs: Array.isArray(parsed.knowledgeRefs)
              ? parsed.knowledgeRefs.filter(
                  (item): item is string => typeof item === "string"
                )
              : [],
          };
        } catch {
          metadata[index] = null;
        }
        return "";
      }
    )
    .trim();
  return { cleanText, metadata };
}

function metadataSummary(metadata: FlowPostMetadata[]): string {
  return metadata
    .map(
      (item, index) =>
        [
          `投稿${index + 1}｜${item.layer}`,
          `切り口: ${item.angle || "Codex選択"}`,
          `フック: ${item.hook || "Codex選択"}`,
          `構造: ${item.structure || "Codex選択"}`,
          `参照: ${item.knowledgeRefs.join("、") || "生成フローの有効ナレッジ"}`,
        ].join("\n")
    )
    .join("\n\n");
}

async function updateFlowStep(
  sessionId: string,
  stepNumber: number,
  stepLabel: string,
  status: "running" | "completed" | "skipped" | "failed",
  options: {
    summary?: string;
    output?: string;
    knowledgeRefs?: string[];
    sessionStatus?: string;
    finalPostBody?: string;
  } = {}
) {
  const now = new Date();
  await prisma.$transaction([
    prisma.generationStep.upsert({
      where: { sessionId_stepNumber: { sessionId, stepNumber } },
      create: {
        sessionId,
        stepNumber,
        stepLabel,
        status,
        summary: options.summary ?? null,
        output: options.output ?? null,
        knowledgeRefs: options.knowledgeRefs
          ? JSON.stringify(options.knowledgeRefs)
          : null,
        startedAt: status === "running" ? now : null,
        completedAt:
          status === "completed" || status === "skipped" || status === "failed"
            ? now
            : null,
      },
      update: {
        stepLabel,
        status,
        ...(options.summary !== undefined
          ? { summary: options.summary }
          : {}),
        ...(options.output !== undefined ? { output: options.output } : {}),
        ...(options.knowledgeRefs !== undefined
          ? { knowledgeRefs: JSON.stringify(options.knowledgeRefs) }
          : {}),
        ...(status === "running" ? { startedAt: now } : {}),
        ...(status === "completed" ||
        status === "skipped" ||
        status === "failed"
          ? { completedAt: now }
          : {}),
      },
    }),
    prisma.generationSession.update({
      where: { id: sessionId },
      data: {
        currentStep: stepNumber,
        ...(options.sessionStatus
          ? { status: options.sessionStatus }
          : {}),
        ...(options.finalPostBody !== undefined
          ? { finalPostBody: options.finalPostBody }
          : {}),
        ...(status === "failed"
          ? {
              status: "failed",
              error: options.summary || "生成に失敗しました",
            }
          : {}),
      },
    }),
  ]);
}

async function failFlow(sessionId: string | null, step: number, message: string) {
  if (!sessionId) return;
  await updateFlowStep(sessionId, step, `STEP${step}`, "failed", {
    summary: message,
  }).catch(() => {});
}

function formatPreviewBody(
  posts: { thread: boolean; items: string[] }[]
): string {
  return posts
    .map(formatSinglePreviewBody)
    .join("\n\n=====\n\n");
}

function formatSinglePreviewBody(post: {
  thread: boolean;
  items: string[];
}): string {
  return post.items
    .map((item, index) => `■${index + 1}\n${item.trim()}`)
    .join("\n\n");
}

/**
 * AI投稿生成エンドポイント（Claude / Codex CLI — 月額プラン範囲内）
 * POST body: { accountId, count, extraInstructions?, provider? }
 */
export async function POST(request: Request) {
  let activeFlowSessionId: string | null = null;
  let activeFlowStep = 0;
  try {
    const {
      accountId,
      count,
      extraInstructions,
      provider: rawProvider,
      previewOnly: rawPreviewOnly,
      flowSessionId,
    } = await request.json();
    const previewOnly = rawPreviewOnly === true;
    activeFlowSessionId =
      typeof flowSessionId === "string" && flowSessionId
        ? flowSessionId
        : null;
    const provider: AiProvider = ["auto", "claude", "codex"].includes(
      rawProvider
    )
      ? rawProvider
      : "auto";
    const extra =
      typeof extraInstructions === "string" ? extraInstructions.trim() : "";

    if (!accountId) {
      return NextResponse.json(
        { error: "accountId required" },
        { status: 400 }
      );
    }

    const flowSession = activeFlowSessionId
      ? await prisma.generationSession.findUnique({
          where: { id: activeFlowSessionId },
        })
      : null;
    if (
      activeFlowSessionId &&
      (!flowSession || flowSession.accountId !== accountId)
    ) {
      return NextResponse.json(
        { error: "生成セッションが見つかりません" },
        { status: 404 }
      );
    }
    const requestedFlowLayers = (flowSession?.layer || "")
      .split(",")
      .map((item) => item.trim())
      .filter(
        (item): item is "L1" | "L2" | "L3" =>
          item === "L1" || item === "L2" || item === "L3"
      );

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
    const allCustomKnowledges = knowledges.filter((k) => k.type === "custom");
    // 専門ナレッジ（07_専門ナレッジ由来）は「参照素材」として別枠で扱う。
    // 通常の追加ナレッジのように全文を対等に連結せず、専用セクションに入れて
    // 「1投稿=1カテゴリだけ選ぶ」という使い方をモデルに指示する（らいとリポと同じ扱い）。
    const SPECIALTY_TITLE_PREFIX = "専門ナレッジ";
    const specialtyKnowledges = allCustomKnowledges.filter((k) =>
      k.title.startsWith(SPECIALTY_TITLE_PREFIX)
    );
    const customKnowledges = allCustomKnowledges.filter(
      (k) => !k.title.startsWith(SPECIALTY_TITLE_PREFIX)
    );

    if (activeFlowSessionId) {
      const knowledgeTitles = knowledges.map((k) => k.title);
      const selectedLayers = (flowSession?.layer || "おまかせ")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const selectedLayerLabel = selectedLayers.join(" / ");
      await updateFlowStep(
        activeFlowSessionId,
        0,
        "STEP0",
        "completed",
        {
          summary: "投稿生成の大前提を確認",
          knowledgeRefs: knowledgeTitles.filter((title) =>
            title.includes("運用指南書")
          ),
        }
      );
      await updateFlowStep(
        activeFlowSessionId,
        1,
        "STEP1",
        "completed",
        {
          summary: `投稿別Layer: ${selectedLayerLabel}`,
          knowledgeRefs: knowledgeTitles.filter(
            (title) =>
              title.includes("コアルール") ||
              title.includes("現行運用パラメータ")
          ),
        }
      );
      await updateFlowStep(
        activeFlowSessionId,
        2,
        "STEP2",
        "completed",
        {
          summary: extra || "悩み・論点はCodexにおまかせ",
          knowledgeRefs: knowledgeTitles.filter(
            (title) =>
              title.includes("悩み素材バンク") ||
              title.includes("アカウントコンセプト") ||
              title.includes("ペルソナ")
          ),
        }
      );
      await updateFlowStep(
        activeFlowSessionId,
        3,
        "STEP3",
        "completed",
        {
          summary: flowSession?.category
            ? `カテゴリ: ${flowSession.category}`
            : "カテゴリはCodexが本文に合わせて選択",
          knowledgeRefs: specialtyKnowledges.map((k) => k.title),
        }
      );
      await updateFlowStep(
        activeFlowSessionId,
        4,
        "STEP4",
        "completed",
        {
          summary: "アカウントの対象読者・痛みと照合",
          knowledgeRefs: knowledgeTitles.filter(
            (title) =>
              title.includes("アカウントコンセプト") ||
              title.includes("ペルソナ")
          ),
        }
      );
      await updateFlowStep(
        activeFlowSessionId,
        5,
        "STEP5",
        "completed",
        {
          summary: "フック型と心理技法の候補を準備",
          knowledgeRefs: knowledgeTitles.filter((title) =>
            title.includes("フック")
          ),
        }
      );
      await updateFlowStep(
        activeFlowSessionId,
        6,
        "STEP6",
        selectedLayers.includes("L3") ? "completed" : "skipped",
        {
          summary:
            selectedLayers.includes("L3")
              ? "稼働案件・CTA条件を照合"
              : "L3指定ではないため、必要な場合だけCodexが照合",
          knowledgeRefs: knowledgeTitles.filter(
            (title) =>
              title.includes("CTA") ||
              title.includes("案件接続") ||
              title.includes("現行運用パラメータ") ||
              title.includes("発信者体験談")
          ),
        }
      );
      activeFlowStep = 7;
      await updateFlowStep(
        activeFlowSessionId,
        7,
        "STEP7",
        "running",
        {
          summary: `${
            provider === "claude"
              ? "Claude"
              : provider === "codex"
                ? "Codex"
                : "AI"
          }が本編の核・構成・フックを生成中`,
          knowledgeRefs: [
            ...specialtyKnowledges.map((k) => k.title),
            ...knowledgeTitles.filter((title) =>
              title.includes("悩み素材バンク")
            ),
          ],
        }
      );
    }

    // 投稿時間帯。1日分の生成本数は、この時間帯の数を正とする。
    const postingHours = normalizeAccountPostingHours(account.postingHours);

    const defaultCount = dailyPostCountFromPostingHours(account.postingHours);
    const wantCount = Math.max(
      1,
      Math.min(MAX_GENERATE_POSTS, Number(count) || defaultCount)
    );

    const usage = getClaudeUsageStatus();
    if (provider === "claude" && usage.maxRecommendedPosts === 0) {
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
      provider === "claude" &&
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
      account.personaSheet || "",
      rulesKnowledge?.content || "",
      structuresKnowledge?.content || "",
      customKnowledges.map((k) => k.content),
      specialtyKnowledges.map((k) => ({ title: k.title, content: k.content })),
      postingHours,
      wantCount,
      extra,
      diversitySection,
      accountId
    );
    const timeoutMs = estimateClaudeGenerationTimeoutMs({
      promptChars: prompt.length,
      count: wantCount,
    });

    const skipClaudeReason =
      provider === "auto" &&
      (usage.maxRecommendedPosts === 0 ||
        (typeof usage.maxRecommendedPosts === "number" &&
          wantCount > usage.maxRecommendedPosts))
        ? "Claudeの利用制限を検知したため"
        : undefined;

    let generated: {
      text: string;
      providerUsed: "claude" | "codex";
      fallbackFrom?: "claude";
    };
    try {
      generated = await generateText(
        prompt,
        provider,
        timeoutMs,
        skipClaudeReason
      );
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : "AI投稿生成に失敗しました。もう一度お試しください。";
      await failFlow(activeFlowSessionId, activeFlowStep, message);
      return NextResponse.json(
        {
          error: message,
        },
        { status: 502 }
      );
    }

    // パースしてDBに保存。WebUIフローでは末尾のメタ情報を本文から分離する。
    let flowExtraction = activeFlowSessionId
      ? extractFlowMetadata(generated.text)
      : { cleanText: generated.text, metadata: [] };
    let posts = parsePosts(flowExtraction.cleanText, wantCount);
    if (
      posts.length === 0 &&
      provider === "auto" &&
      generated.providerUsed === "claude"
    ) {
      try {
        const codexText = await generateWithCodex(prompt, timeoutMs);
        const codexExtraction = activeFlowSessionId
          ? extractFlowMetadata(codexText)
          : { cleanText: codexText, metadata: [] };
        const codexPosts = parsePosts(codexExtraction.cleanText, wantCount);
        if (codexPosts.length > 0) {
          generated = {
            text: codexText,
            providerUsed: "codex",
            fallbackFrom: "claude",
          };
          flowExtraction = codexExtraction;
          posts = codexPosts;
        }
      } catch (e) {
        console.warn(
          "Claude output parse failed and Codex fallback also failed:",
          e
        );
      }
    }

    if (posts.length === 0) {
      await failFlow(
        activeFlowSessionId,
        activeFlowStep,
        "Codexの出力を投稿形式に分割できませんでした"
      );
      return NextResponse.json(
        {
          error:
            "AIの出力を投稿に分割できませんでした。出力フォーマットが崩れた可能性があります。もう一度「生成開始」を押してみてください。",
          detail: generated.text.slice(0, 500),
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
    if (activeFlowSessionId && finalPosts.length !== wantCount) {
      const message = `指定した${wantCount}投稿のうち、${skippedSimilar}投稿が過去投稿または同じ生成内で似ていたため採用できませんでした。切り口を変えてもう一度生成してください。`;
      await failFlow(activeFlowSessionId, 10, message);
      return NextResponse.json({ error: message }, { status: 422 });
    }
    if (finalPosts.length === 0) {
      await failFlow(
        activeFlowSessionId,
        10,
        "過去投稿との類似が高く、生成結果を採用できませんでした"
      );
      return NextResponse.json(
        {
          error:
            "生成した投稿がすべて過去の投稿と似すぎていたため、保存をスキップしました。もう一度生成するか、「追加指示」で別の場面・悩み・結論を指定してください。",
        },
        { status: 422 }
      );
    }

    const finalMetadata: FlowPostMetadata[] = kept.map(
      ({ post, plan }, keptIndex) => {
        const reported = flowExtraction.metadata[plan.index];
        const bodyLayer = post.items[0]?.match(/^\s*\[(L[123])\]/)?.[1];
        const layer =
          reported?.layer && reported.layer !== "不明"
            ? reported.layer
            : bodyLayer === "L1" || bodyLayer === "L2" || bodyLayer === "L3"
              ? bodyLayer
              : requestedFlowLayers[plan.index] ||
                requestedFlowLayers[keptIndex] ||
                "不明";
        return {
          layer,
          angle: reported?.angle || plan.scene,
          hook: reported?.hook || plan.type,
          structure: reported?.structure || "生成AIが選択",
          knowledgeRefs: reported?.knowledgeRefs || [],
        };
      }
    );

    // 実データ（時間別パフォーマンス）から推奨枠を割り出す。失敗時はnull→従来ルールにフォールバック。
    const preferred = await computeAccountBestHours(accountId, postingHours).catch(
      () => null
    );

    const recommendations = buildRecommendedPostingPlan(
      [account.conceptSheet, account.personaSheet]
        .filter(Boolean)
        .join("\n\n"),
      postingHours,
      finalPosts.length,
      { postTexts: finalPosts.map((post) => post.items.join("\n\n")), preferred }
    );

    if (activeFlowSessionId) {
      const previewBody = formatPreviewBody(finalPosts);
      await updateFlowStep(activeFlowSessionId, 7, "STEP7", "completed", {
        summary: "本編の核を選択",
      });
      await updateFlowStep(activeFlowSessionId, 8, "STEP8", "completed", {
        summary: "ツリー構成を決定",
      });
      await updateFlowStep(activeFlowSessionId, 9, "STEP9", "completed", {
        summary: "フックと本文を生成",
      });
      await updateFlowStep(activeFlowSessionId, 10, "STEP10", "completed", {
        summary:
          skippedSimilar > 0
            ? `類似度チェック完了（${skippedSimilar}件を除外）`
            : "過去投稿との重複なし",
      });
      await updateFlowStep(activeFlowSessionId, 11, "STEP11", "completed", {
        summary: "形式・整合性チェック完了",
      });
      await updateFlowStep(activeFlowSessionId, 12, "STEP12", "completed", {
        summary: `${
          generated.providerUsed === "claude" ? "Claude" : "Codex"
        }生成・ファクト確認完了`,
      });
      await updateFlowStep(activeFlowSessionId, 13, "STEP13", "completed", {
        summary: "最終稿を整形",
        output: metadataSummary(finalMetadata),
      });
      await updateFlowStep(activeFlowSessionId, 135, "STEP13.5", "running", {
        summary: "画面での承認待ち",
        sessionStatus: "awaiting_approval",
        finalPostBody: previewBody,
      });

      if (previewOnly) {
        return NextResponse.json({
          count: finalPosts.reduce((sum, post) => sum + post.items.length, 0),
          posts: finalPosts.length,
          skippedSimilar,
          recommendations,
          providerUsed: generated.providerUsed,
          fallbackFrom: generated.fallbackFrom,
          preview: true,
          sessionId: activeFlowSessionId,
          finalPostBody: previewBody,
          previewPosts: finalPosts.map((post, index) => ({
            body: formatSinglePreviewBody(post),
            metadata: finalMetadata[index],
            recommendation: recommendations[index] || null,
          })),
        });
      }
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
        providerUsed: generated.providerUsed,
        fallbackFrom: generated.fallbackFrom,
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("generate error:", e);
    const message = e instanceof Error ? e.message : String(e);
    await failFlow(activeFlowSessionId, activeFlowStep, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function generateText(
  prompt: string,
  provider: AiProvider,
  timeoutMs: number,
  skipClaudeReason?: string
): Promise<{
  text: string;
  providerUsed: "claude" | "codex";
  fallbackFrom?: "claude";
}> {
  if (provider === "claude") {
    return {
      text: await generateWithClaude(prompt, timeoutMs),
      providerUsed: "claude",
    };
  }

  if (provider === "codex") {
    return {
      text: await generateWithCodex(prompt, timeoutMs),
      providerUsed: "codex",
    };
  }

  if (!skipClaudeReason) {
    try {
      return {
        text: await generateWithClaude(prompt, timeoutMs),
        providerUsed: "claude",
      };
    } catch (e) {
      skipClaudeReason =
        e instanceof Error ? e.message : "Claudeでの生成に失敗しました。";
      console.warn("Claude failed; falling back to Codex:", skipClaudeReason);
    }
  }

  try {
    return {
      text: await generateWithCodex(prompt, timeoutMs),
      providerUsed: "codex",
      fallbackFrom: "claude",
    };
  } catch (e) {
    const codexError =
      e instanceof Error ? e.message : "Codexでの生成に失敗しました。";
    throw new Error(
      `ClaudeとCodexの両方で生成できませんでした。\nClaude: ${skipClaudeReason}\nCodex: ${codexError}`
    );
  }
}

async function generateWithClaude(
  prompt: string,
  timeoutMs: number
): Promise<string> {
  try {
    const text = await runClaude(prompt, { timeoutMs });
    if (!text.trim()) {
      throw new Error("Claudeからの応答が空でした。");
    }
    return text;
  } catch (e: unknown) {
    const error = e as ClaudeCliError;
    const raw =
      `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`.trim();
    recordClaudeUsageLimitError(raw);
    console.error("Claude CLI error:", raw);
    throw new Error(describeClaudeCliError(raw, error));
  }
}

async function generateWithCodex(
  prompt: string,
  timeoutMs: number
): Promise<string> {
  try {
    const text = await runCodex(prompt, { timeoutMs });
    if (!text.trim()) {
      throw new Error("Codexからの応答が空でした。");
    }
    return text;
  } catch (e: unknown) {
    const error = e as CodexCliError;
    const raw =
      `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`.trim();
    console.error("Codex CLI error:", raw);
    throw new Error(describeCodexCliError(raw, error));
  }
}

// ===========================================================
// プロンプト構築
// ===========================================================
// 「らいと」アカウント専用の体裁オーバーライドを効かせる対象アカウントID。
// このIDのときだけ、らいと固有の体裁（句点改行・空行ゼロ・■1=100字以内かつ問題提起のみ・
// Layer別ツリー数=最大4）を汎用ブロックより優先させる。他アカウント（新規作成含む）は従来どおり。
const RAITO_ACCOUNT_ID = "cmoz8pe6i0000w8s8rwz7w0j8";

function buildPrompt(
  conceptSheet: string,
  personaSheet: string,
  rules: string,
  structures: string,
  customKnowledges: string[],
  specialtyKnowledges: { title: string; content: string }[],
  postingHours: number[],
  count: number,
  extraInstructions: string = "",
  diversitySection: string = "",
  accountId: string = ""
): string {
  const isRaito = accountId === RAITO_ACCOUNT_ID;
  const parts = [
    "あなたはSNSコンテンツの専門家です。以下のアカウントコンセプト・ペルソナ設計・ルール・構成パターンに基づき、そのまま投稿できる品質のThreads投稿を生成してください。",
    "",
    "## アカウントコンセプト（発信者・テーマ・価値・トーン）",
    conceptSheet,
    "",
  ];

  if (personaSheet) {
    parts.push(
      "## ペルソナ設計（この読者1人に向けて書く）",
      personaSheet,
      "",
      "ペルソナ設計の属性を毎回すべて説明せず、各投稿では具体的な場面・悩み・感情を1つだけ選んで反映すること。",
      ""
    );
  }

  if (diversitySection) {
    parts.push(diversitySection, "");
  }

  if (extraInstructions) {
    parts.push(
      "## 🔴 今回の追加指示（このバッチでのみ最優先で従うこと）",
      "下記はユーザーが今回の生成のために明示的に指定した追加指示です。",
      "アカウントコンセプト・ペルソナ設計・ナレッジ・生成ルールと矛盾する場合は **この追加指示を優先** すること。",
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

  // 専門ナレッジ（参照素材）。らいとリポと同じ扱い＝1投稿=1カテゴリだけ選んで使う。
  // 通常の追加ナレッジとは混ぜず、使い方・優先順位を添えた専用セクションにまとめる。
  if (specialtyKnowledges.length > 0) {
    parts.push(
      "## 専門ナレッジ（参照素材 — 1投稿=1カテゴリだけ選んで使う）",
      "これは投稿の解決策が毎回似通う（特に「退職理由の言い換え」に寄る）のを防ぐための参照素材です。トーン変換・口語ルール・安全ルールの本体は持たず、参照に徹します。次の使い方を守ること：",
      "- 1投稿につきカテゴリを1つだけ宣言し、その1論点で書く（複数カテゴリを混ぜない）。",
      "- 各カテゴリの「原因・背景」は■1の問題提起／■2の共感の素材に、「判断軸・今日できるアクション」は本編の核に使う。フックはこの専門ナレッジから作らず、フック系ナレッジと生成ルールで作る。",
      "- 解決策を「まず休みましょう」「まず転職を」に毎回寄せない。action系（自己観察／境界判断／証拠保存／条件確認／適職探索／面接言語化）を1〜2個に絞り、1バッチ内で同じカテゴリ×同じaction系を繰り返さない。",
      "- 優先順位（衝突時）：この専門ナレッジ ＜ 上の『投稿生成ルール』 ＜ 『今回の追加指示』。上位を優先する。医療診断・法的断定はしない。",
      "- 「参考ソース一覧」は直接引用しすぎず、各カテゴリの変換済み知識を優先する。",
      ""
    );
    for (const s of specialtyKnowledges) {
      parts.push(`### ${s.title}`, s.content, "");
    }
  }

  // 体裁の優先順位：らいとアカウントのときだけ、固有の「投稿生成ルール」が定める
  // 文字数・改行・ツリー数・構成役割を、下記の汎用の数値より優先させる。
  // 他アカウント（新規作成含む）では挿入せず、従来どおり下記の汎用体裁が効く。
  if (isRaito) {
    parts.push(
      "## 体裁の優先順位（重要）",
      "下に汎用の『品質基準・生成指示・出力フォーマット』を置くが、**上の『## 投稿生成ルール』が文字数・改行・1スレッドの投稿数（ツリー数）・各投稿の構成役割（■1で何を書くか等）について固有の指定をしている場合は、必ずそのルールを優先する**。下記の数値（各投稿200〜500字／2〜3投稿／■1=フック＋橋渡し 等）は、ルールに該当の指定が無い場合のデフォルトとして扱うこと。マーカー（■1/■2…）・スレッド区切り（=====）・マークダウン不使用は常に下記フォーマットに従う。",
      ""
    );
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
    isRaito
      ? "- 各スレッドは原則 **2投稿（基本）または3投稿（深い話・ステップ系のみ）** で構成する（読者離脱率・API側のリプライ伝播ラグ対策のデフォルト）。**ただし上の『投稿生成ルール』がツリー数を別途定めている場合は必ずそれに従う**（例: 一部の型は4投稿まで許容）。いずれの場合も5投稿以上は禁止。"
      : "- 各スレッドは **2投稿（基本）または3投稿（深い話・ステップ系のみ）** で構成する。**4投稿以上は厳禁**（読者離脱率が急増し、API側のリプライ伝播ラグで投稿失敗率も上がるため）",
    "- 2投稿型: ■1 フック＋橋渡し / ■2 本編＋締め（CTAあれば最後に自然に溶け込ませる）",
    "- 3投稿型: ■1 フック / ■2 本編 / ■3 締め＋CTA",
    ...(isRaito
      ? [
          "- ※上記の投稿型・■1の役割（フック＋橋渡し等）はデフォルト。上の『投稿生成ルール』が■1の役割や並びを別途定めている場合はそちらを優先する",
        ]
      : []),
    isRaito
      ? "- 各投稿（1スレッド内の各リプライ）は200〜500字（**ただし上の『投稿生成ルール』が特定の投稿に別の字数上限を定めている場合はそちらを優先**。例: フック＝■1を短く制限する等）"
      : "- 各投稿（1スレッド内の各リプライ）は200〜500字",
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
    isRaito
      ? "- 各投稿の先頭は必ず行頭に「■1」「■2」。原則「■3」まで（上の『投稿生成ルール』が4投稿型を認める場合のみ「■4」まで可）。■5以上は禁止"
      : "- 各投稿の先頭は必ず行頭に「■1」「■2」（深い話のみ「■3」まで）。■4以上は禁止",
    "- 「投稿1:」「スレッド1」「1本目」のような見出しラベルは付けない。■マーカーだけで区切る",
    "- 本文中に **太字**、## 見出し、- や 1. の箇条書き、表 などのマークダウン記法を使わない",
    isRaito
      ? "- 1スレッドにつき ■マーカーは2個以上（原則2〜3個、上の『投稿生成ルール』が認める型のみ4個まで）。必ず複数の■を含めること"
      : "- 1スレッドにつき ■マーカーは2個（または3個）。必ず複数の■を含めること",
    `- 最終的に「=====」で区切られたスレッドのかたまりが ${count} 個になるように出力する`
  );

  if (isRaito) {
    parts.push(
      "",
      "### Layer種別タグ",
      "各スレッドの■1本文の**1行目**に、そのスレッドのLayer種別タグを記載すること（アプリがタグを検出して色付きバッジとして表示し、本文からは自動除去する）。タグは以下の3種のいずれか：",
      "- [L1] … Layer1（フォロー誘導：認知・共感・フォロー獲得）",
      "- [L2] … Layer2（教育：深掘り・判断軸・信頼構築）",
      "- [L3] … Layer3（アフィ誘導：CTA・プロフ誘導・CV獲得）",
      "出力例：",
      "■1",
      "[L1]",
      "（フックの本文…）",
      "",
      "タグはアプリが自動除去するので字数に含めない。■1にだけ付け、■2以降には付けない。"
    );
  }

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
