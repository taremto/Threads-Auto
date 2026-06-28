import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const accountId = url.searchParams.get("accountId");
    const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);

    const sessions = await prisma.generationSession.findMany({
      where: accountId ? { accountId } : undefined,
      include: { steps: { orderBy: { stepNumber: "asc" } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json(sessions);
  } catch (e) {
    console.error("generation-flow sessions error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
