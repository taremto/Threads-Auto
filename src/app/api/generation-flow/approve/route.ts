import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { parsePosts } from "@/lib/post-parser";
import { buildRecommendedPostingPlan } from "@/lib/recommended-times";
import { computeAccountBestHours } from "@/lib/insights/best-hours";
import { normalizeAccountPostingHours } from "@/lib/account-posting";

type ApprovalGroup = {
  rootPostId: string;
  postIds: string[];
  index: number;
};

type ApprovalOutput = {
  groups: ApprovalGroup[];
};

type ReviewDecision = {
  postNumber: number;
  status: "approved" | "rejected" | "pending";
  feedback: string;
};

function formatFinalPostBody(
  posts: Array<{ items: string[] }>
): string {
  return posts
    .map((post) =>
      post.items
        .map((item, index) => `■${index + 1}\n${item.trim()}`)
        .join("\n\n")
    )
    .join("\n\n=====\n\n");
}

function parseApprovalOutput(raw: string | null): ApprovalOutput | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ApprovalOutput & {
      rootPostId?: string;
      postIds?: string[];
    };
    if (
      Array.isArray(parsed.groups) &&
      parsed.groups.every(
        (group) =>
          typeof group.rootPostId === "string" &&
          Array.isArray(group.postIds) &&
          group.postIds.every((id) => typeof id === "string")
      )
    ) {
      return parsed;
    }
    // 旧1投稿形式との後方互換。
    if (
      typeof parsed.rootPostId === "string" &&
      Array.isArray(parsed.postIds)
    ) {
      return {
        groups: [
          {
            rootPostId: parsed.rootPostId,
            postIds: parsed.postIds,
            index: 0,
          },
        ],
      };
    }
  } catch {
    // 投稿本文などは承認情報として扱わない。
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const editedBody =
      typeof body.finalPostBody === "string"
        ? body.finalPostBody.trim()
        : "";
    const autoSave = body.autoSave === true;
    const updateExisting = body.updateExisting === true;
    const allRejected = body.allRejected === true;
    const reviewDecisions: ReviewDecision[] = Array.isArray(
      body.reviewDecisions
    )
      ? (body.reviewDecisions as unknown[])
          .map((item: unknown) => {
            if (!item || typeof item !== "object") return null;
            const decision = item as Record<string, unknown>;
            const status =
              decision.status === "approved"
                ? "approved"
                : decision.status === "rejected"
                  ? "rejected"
                  : "pending";
            return {
              postNumber:
                typeof decision.postNumber === "number"
                  ? decision.postNumber
                  : 0,
              status,
              feedback:
                typeof decision.feedback === "string"
                  ? decision.feedback.trim().slice(0, 2_000)
                  : "",
            };
          })
          .filter(
            (item): item is ReviewDecision => item !== null
          )
          .slice(0, 50)
      : [];

    if (!sessionId) {
      return NextResponse.json(
        { error: "生成セッションが見つかりません" },
        { status: 400 }
      );
    }

    const session = await prisma.generationSession.findUnique({
      where: { id: sessionId },
      include: { steps: true },
    });
    if (!session) {
      return NextResponse.json(
        { error: "生成セッションが見つかりません" },
        { status: 404 }
      );
    }

    if (allRejected) {
      if (
        reviewDecisions.length === 0 ||
        reviewDecisions.some((decision) => decision.status !== "rejected")
      ) {
        return NextResponse.json(
          { error: "全件否認の判定情報を確認してください" },
          { status: 400 }
        );
      }
      const now = new Date();
      const reviewOutput = JSON.stringify({ reviewDecisions });
      await prisma.$transaction([
        prisma.generationStep.upsert({
          where: { sessionId_stepNumber: { sessionId, stepNumber: 135 } },
          create: {
            sessionId,
            stepNumber: 135,
            stepLabel: "STEP13.5",
            status: "completed",
            summary: `${reviewDecisions.length}投稿をすべて否認`,
            output: reviewOutput,
            completedAt: now,
          },
          update: {
            status: "completed",
            summary: `${reviewDecisions.length}投稿をすべて否認`,
            output: reviewOutput,
            completedAt: now,
          },
        }),
        prisma.generationStep.upsert({
          where: { sessionId_stepNumber: { sessionId, stepNumber: 14 } },
          create: {
            sessionId,
            stepNumber: 14,
            stepLabel: "STEP14",
            status: "completed",
            summary: "全件否認のため下書き保存なし",
            output: JSON.stringify({ groups: [] }),
            startedAt: now,
            completedAt: now,
          },
          update: {
            status: "completed",
            summary: "全件否認のため下書き保存なし",
            output: JSON.stringify({ groups: [] }),
            startedAt: now,
            completedAt: now,
          },
        }),
        prisma.generationSession.update({
          where: { id: sessionId },
          data: {
            status: "completed",
            currentStep: 14,
            finalPostBody: null,
            error: null,
          },
        }),
      ]);
      return NextResponse.json({
        ok: true,
        groups: [],
        allRejected: true,
      });
    }

    const requestedFinalPostBody =
      editedBody || session.finalPostBody?.trim() || "";
    if (!requestedFinalPostBody) {
      return NextResponse.json(
        { error: "承認する投稿本文がありません" },
        { status: 400 }
      );
    }

    const parsed = parsePosts(requestedFinalPostBody, 1);
    if (parsed.length === 0 || parsed.some((post) => post.items.length === 0)) {
      return NextResponse.json(
        { error: "投稿本文をツリーに分割できませんでした" },
        { status: 422 }
      );
    }
    const finalPostBody = formatFinalPostBody(parsed);

    const step14 = session.steps.find((step) => step.stepNumber === 14);
    const previousApproval = parseApprovalOutput(step14?.output ?? null);
    if (previousApproval) {
      const existingRoots = await prisma.post.count({
        where: {
          id: {
            in: previousApproval.groups.map((group) => group.rootPostId),
          },
        },
      });
      if (existingRoots === previousApproval.groups.length) {
        if (updateExisting && editedBody) {
          const orderedGroups = [...previousApproval.groups].sort(
            (a, b) => a.index - b.index
          );
          const structureMatches =
            orderedGroups.length === parsed.length &&
            orderedGroups.every(
              (group, index) =>
                group.postIds.length === parsed[index]?.items.length
            );
          if (!structureMatches) {
            return NextResponse.json(
              {
                error:
                  "投稿数またはツリーのコマ数が変わっています。本文だけを修正して、もう一度お試しください。",
              },
              { status: 422 }
            );
          }

          const postIds = orderedGroups.flatMap((group) => group.postIds);
          const existingPosts = await prisma.post.findMany({
            where: { id: { in: postIds } },
            select: { id: true, status: true },
          });
          if (
            existingPosts.length !== postIds.length ||
            existingPosts.some((post) => post.status !== "draft")
          ) {
            return NextResponse.json(
              {
                error:
                  "キュー追加後または投稿済みの投稿は、この画面から修正できません。下書きタブで状態を確認してください。",
              },
              { status: 409 }
            );
          }

          await prisma.$transaction(async (tx) => {
            for (const [postIndex, group] of orderedGroups.entries()) {
              for (const [itemIndex, postId] of group.postIds.entries()) {
                const item = parsed[postIndex].items[itemIndex].trim();
                await tx.post.update({
                  where: { id: postId },
                  data: { body: item, charCount: item.length },
                });
              }
            }
            await tx.generationSession.update({
              where: { id: sessionId },
              data: { finalPostBody },
            });
          });
          return NextResponse.json({
            ok: true,
            groups: previousApproval.groups,
            reused: true,
            updated: true,
          });
        }
        return NextResponse.json({
          ok: true,
          groups: previousApproval.groups,
          reused: true,
        });
      }
    }

    const account = await prisma.account.findUnique({
      where: { id: session.accountId },
    });
    if (!account) {
      return NextResponse.json(
        { error: "アカウントが見つかりません" },
        { status: 404 }
      );
    }

    const postingHours = normalizeAccountPostingHours(account.postingHours);
    const preferred = await computeAccountBestHours(
      account.id,
      postingHours
    ).catch(() => null);
    const recommendations = buildRecommendedPostingPlan(
      [account.conceptSheet, account.personaSheet]
        .filter(Boolean)
        .join("\n\n"),
      postingHours,
      parsed.length,
      {
        postTexts: parsed.map((post) => post.items.join("\n\n")),
        preferred,
      }
    );

    const [maxGroup, maxSort] = await Promise.all([
      prisma.post.aggregate({
        where: { accountId: account.id },
        _max: { groupNo: true },
      }),
      prisma.post.aggregate({
        where: { accountId: account.id },
        _max: { sortOrder: true },
      }),
    ]);
    let nextGroupNo = (maxGroup._max.groupNo ?? 0) + 1;
    let nextSortOrder = (maxSort._max.sortOrder ?? 0) + 1;

    const groups = await prisma.$transaction(async (tx) => {
      const createdGroups: ApprovalGroup[] = [];
      for (const [index, post] of parsed.entries()) {
        const recommendation = recommendations[index];
        const groupNo = nextGroupNo++;
        const postIds: string[] = [];
        for (const item of post.items) {
          const created = await tx.post.create({
            data: {
              accountId: account.id,
              groupNo,
              body: item,
              postType: post.items.length > 1 ? "thread" : "standalone",
              charCount: item.length,
              status: "draft",
              batchFile: "codex-generation-flow",
              sortOrder: nextSortOrder++,
              ...(recommendation
                ? {
                    recommendedHour: recommendation.hour,
                    recommendedLabel: recommendation.label,
                    recommendedReason: recommendation.reason,
                  }
                : {}),
            },
            select: { id: true },
          });
          postIds.push(created.id);
        }
        createdGroups.push({
          rootPostId: postIds[0],
          postIds,
          index,
        });
      }
      return createdGroups;
    });

    const approvalOutput: ApprovalOutput = { groups };
    const now = new Date();
    const approvedDecisionCount = reviewDecisions.filter(
      (decision) => decision.status === "approved"
    ).length;
    const finalReviewSummary =
      reviewDecisions.length > 0
        ? `${approvedDecisionCount}投稿を個別承認して下書きへ保存`
        : autoSave
          ? `${groups.length}投稿を生成結果から下書きへ自動保存`
          : `${groups.length}投稿をユーザー承認済み`;
    const finalSaveSummary =
      reviewDecisions.length > 0
        ? "個別承認された投稿を下書きへ保存"
        : autoSave
          ? "下書きへ保存。確認・AI修正待ち"
          : "下書きを作成。キュー追加処理中";
    await prisma.$transaction([
      prisma.generationStep.upsert({
        where: { sessionId_stepNumber: { sessionId, stepNumber: 135 } },
        create: {
          sessionId,
          stepNumber: 135,
          stepLabel: "STEP13.5",
          status: "completed",
          summary: finalReviewSummary,
          output:
            reviewDecisions.length > 0
              ? JSON.stringify({ reviewDecisions })
              : null,
          completedAt: now,
        },
        update: {
          status: "completed",
          summary: finalReviewSummary,
          output:
            reviewDecisions.length > 0
              ? JSON.stringify({ reviewDecisions })
              : undefined,
          completedAt: now,
        },
      }),
      prisma.generationStep.upsert({
        where: { sessionId_stepNumber: { sessionId, stepNumber: 14 } },
        create: {
          sessionId,
          stepNumber: 14,
          stepLabel: "STEP14",
          status: autoSave ? "completed" : "running",
          summary: finalSaveSummary,
          output: JSON.stringify(approvalOutput),
          startedAt: now,
          completedAt: autoSave ? now : null,
        },
        update: {
          status: autoSave ? "completed" : "running",
          summary: finalSaveSummary,
          output: JSON.stringify(approvalOutput),
          startedAt: now,
          completedAt: autoSave ? now : null,
        },
      }),
      prisma.generationSession.update({
        where: { id: sessionId },
        data: {
          status: "approved",
          currentStep: 14,
          finalPostBody,
          error: null,
        },
      }),
    ]);

    return NextResponse.json({
      ok: true,
      groups,
      recommendations,
    });
  } catch (error) {
    console.error("generation-flow approve error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "承認処理に失敗しました",
      },
      { status: 500 }
    );
  }
}
