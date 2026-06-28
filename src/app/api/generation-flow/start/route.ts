import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

const VALID_LAYERS = new Set(["L1", "L2", "L3"]);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accountId =
      typeof body.accountId === "string" ? body.accountId.trim() : "";
    const layers = Array.isArray(body.layers)
      ? body.layers
          .map((item: unknown) =>
            typeof item === "string" ? item.trim() : ""
          )
          .filter((item: string) => VALID_LAYERS.has(item))
          .slice(0, 30)
      : [];
    const category =
      typeof body.category === "string" && body.category.trim()
        ? body.category.trim().slice(0, 100)
        : null;

    if (!accountId) {
      return NextResponse.json(
        { error: "アカウントを選択してください" },
        { status: 400 }
      );
    }

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, conceptSheet: true },
    });
    if (!account) {
      return NextResponse.json(
        { error: "アカウントが見つかりません" },
        { status: 404 }
      );
    }
    if (!account.conceptSheet) {
      return NextResponse.json(
        {
          error:
            "コンセプトシートが未設定です。システム設定から入力してください。",
        },
        { status: 400 }
      );
    }

    const session = await prisma.generationSession.create({
      data: {
        accountId,
        status: "running",
        currentStep: 0,
        layer: layers.length > 0 ? layers.join(",") : null,
        category,
        steps: {
          create: {
            stepNumber: 0,
            stepLabel: "STEP0",
            status: "running",
            summary: "投稿生成フローを開始",
            knowledgeRefs: JSON.stringify(["運用指南書"]),
            startedAt: new Date(),
          },
        },
      },
    });

    return NextResponse.json(
      { sessionId: session.id, ok: true },
      { status: 201 }
    );
  } catch (error) {
    console.error("generation-flow start error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "生成フローを開始できませんでした",
      },
      { status: 500 }
    );
  }
}
