import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const sessions = await prisma.generationSession.findMany({
      where: { status: "running" },
      include: { steps: { orderBy: { stepNumber: "asc" } } },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(sessions);
  } catch (e) {
    console.error("generation-flow active error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
