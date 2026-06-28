import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      sessionId,
      accountId,
      step,
      stepLabel,
      status,
      summary,
      output,
      knowledgeRefs,
      sessionData,
    } = body;

    const stepNumber = typeof step === "number" ? step : 0;
    const now = new Date();

    const stepFields = {
      stepNumber,
      stepLabel: stepLabel || `STEP${stepNumber}`,
      status: status || "running",
      summary: summary || null,
      output: output || null,
      knowledgeRefs: knowledgeRefs ? JSON.stringify(knowledgeRefs) : null,
      startedAt: status === "running" ? now : undefined,
      completedAt:
        status === "completed" || status === "failed" || status === "skipped"
          ? now
          : undefined,
    };

    if (!sessionId) {
      if (!accountId) {
        return NextResponse.json(
          { error: "accountId required for new session" },
          { status: 400 }
        );
      }

      const session = await prisma.generationSession.create({
        data: {
          accountId,
          status:
            status === "failed"
              ? "failed"
              : status === "completed" && stepNumber === 14
                ? "completed"
                : "running",
          currentStep: stepNumber,
          ...(sessionData?.layer && { layer: sessionData.layer }),
          ...(sessionData?.category && { category: sessionData.category }),
          ...(sessionData?.hookType && { hookType: sessionData.hookType }),
          ...(sessionData?.templateName && {
            templateName: sessionData.templateName,
          }),
          steps: {
            create: stepFields,
          },
        },
      });

      return NextResponse.json({ sessionId: session.id, ok: true }, { status: 201 });
    }

    await prisma.generationStep.upsert({
      where: {
        sessionId_stepNumber: { sessionId, stepNumber },
      },
      create: { sessionId, ...stepFields },
      update: stepFields,
    });

    const sessionUpdate: Record<string, unknown> = {
      currentStep: stepNumber,
    };
    if (sessionData) {
      if (sessionData.layer) sessionUpdate.layer = sessionData.layer;
      if (sessionData.category) sessionUpdate.category = sessionData.category;
      if (sessionData.hookType) sessionUpdate.hookType = sessionData.hookType;
      if (sessionData.templateName)
        sessionUpdate.templateName = sessionData.templateName;
      if (sessionData.finalPostBody)
        sessionUpdate.finalPostBody = sessionData.finalPostBody;
      if (sessionData.error) sessionUpdate.error = sessionData.error;
    }
    if (status === "failed") sessionUpdate.status = "failed";
    if (status === "completed" && stepNumber === 14) {
      sessionUpdate.status = "completed";
    }

    await prisma.generationSession.update({
      where: { id: sessionId },
      data: sessionUpdate,
    });

    return NextResponse.json({ sessionId, ok: true });
  } catch (e) {
    console.error("generation-flow progress error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
