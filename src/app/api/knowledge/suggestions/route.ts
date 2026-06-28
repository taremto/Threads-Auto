import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

const RULE_SECTION = "## 投稿AI修正から追加したルール";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get("accountId")?.trim() || "";
    if (!accountId) {
      return NextResponse.json(
        { error: "accountId required" },
        { status: 400 }
      );
    }

    const suggestions = await prisma.knowledgeRevisionSuggestion.findMany({
      where: { accountId, status: "pending" },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    return NextResponse.json(suggestions);
  } catch (error) {
    console.error("knowledge suggestions GET error:", error);
    return NextResponse.json(
      {
        error:
          "ナレッジ反映候補の取得に失敗しました: " +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const action = body.action === "apply" ? "apply" : body.action === "skip" ? "skip" : "";
    if (!id || !action) {
      return NextResponse.json(
        { error: "id と action が必要です" },
        { status: 400 }
      );
    }

    const suggestion = await prisma.knowledgeRevisionSuggestion.findUnique({
      where: { id },
    });
    if (!suggestion) {
      return NextResponse.json(
        { error: "ナレッジ反映候補が見つかりません" },
        { status: 404 }
      );
    }
    if (suggestion.status !== "pending") {
      return NextResponse.json({
        ok: true,
        reused: true,
        status: suggestion.status,
      });
    }

    if (action === "skip") {
      await prisma.knowledgeRevisionSuggestion.update({
        where: { id },
        data: { status: "skipped" },
      });
      return NextResponse.json({ ok: true, status: "skipped" });
    }

    const mode =
      body.mode === "existing" ? "existing" : body.mode === "new" ? "new" : "";
    const ruleText = normalizeRuleText(body.ruleText);
    if (!mode || !ruleText) {
      return NextResponse.json(
        { error: "反映方法とナレッジに入れる内容を確認してください" },
        { status: 400 }
      );
    }
    const ruleBlock = toRuleBullets(ruleText);

    if (mode === "existing") {
      const targetKnowledgeId =
        typeof body.targetKnowledgeId === "string"
          ? body.targetKnowledgeId.trim()
          : "";
      if (!targetKnowledgeId) {
        return NextResponse.json(
          { error: "反映先のナレッジを選択してください" },
          { status: 400 }
        );
      }

      const target = await prisma.knowledge.findUnique({
        where: { id: targetKnowledgeId },
      });
      if (!target) {
        return NextResponse.json(
          { error: "反映先のナレッジが見つかりません" },
          { status: 404 }
        );
      }
      if (target.isDefault) {
        return NextResponse.json(
          {
            error:
              "製品デフォルトのナレッジは更新できません。アカウント専用または共通の追加ナレッジを選んでください。",
          },
          { status: 400 }
        );
      }
      if (
        target.accountId !== null &&
        target.accountId !== suggestion.accountId
      ) {
        return NextResponse.json(
          { error: "別アカウントのナレッジには反映できません" },
          { status: 403 }
        );
      }

      const nextContent = appendRule(target.content, ruleBlock);
      await prisma.$transaction([
        prisma.knowledge.update({
          where: { id: target.id },
          data: { content: nextContent },
        }),
        prisma.knowledgeRevisionSuggestion.update({
          where: { id },
          data: {
            status: "applied",
            targetKnowledgeId: target.id,
          },
        }),
      ]);
      return NextResponse.json({
        ok: true,
        status: "applied",
        knowledgeId: target.id,
        knowledgeTitle: target.title,
      });
    }

    const title =
      typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
    if (!title) {
      return NextResponse.json(
        { error: "新しいナレッジのタイトルを入力してください" },
        { status: 400 }
      );
    }
    const maxSort = await prisma.knowledge.aggregate({
      where: { accountId: suggestion.accountId },
      _max: { sortOrder: true },
    });
    const created = await prisma.$transaction(async (tx) => {
      const knowledge = await tx.knowledge.create({
        data: {
          accountId: suggestion.accountId,
          type: "custom",
          title,
          content: `# ${title}\n\n${RULE_SECTION}\n${ruleBlock}`,
          isDefault: false,
          enabled: true,
          sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
        },
      });
      await tx.knowledgeRevisionSuggestion.update({
        where: { id },
        data: {
          status: "applied",
          targetKnowledgeId: knowledge.id,
        },
      });
      return knowledge;
    });
    return NextResponse.json({
      ok: true,
      status: "applied",
      knowledgeId: created.id,
      knowledgeTitle: created.title,
    });
  } catch (error) {
    console.error("knowledge suggestions PATCH error:", error);
    return NextResponse.json(
      {
        error:
          "ナレッジへの反映に失敗しました: " +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 500 }
    );
  }
}

function normalizeRuleText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, 2_000);
}

function toRuleBullets(ruleText: string): string {
  return ruleText
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*・]\s*/, ""))
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
}

function appendRule(content: string, ruleBlock: string): string {
  if (content.includes(ruleBlock)) return content;
  const trimmed = content.trimEnd();
  if (trimmed.includes(RULE_SECTION)) {
    return `${trimmed}\n${ruleBlock}\n`;
  }
  return `${trimmed}\n\n${RULE_SECTION}\n${ruleBlock}\n`;
}
