import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const accounts = await prisma.account.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      threadsUsername: true,
    },
  });

  const stats = await Promise.all(
    accounts.map(async (acc) => {
      const counts = await prisma.post.groupBy({
        by: ["status"],
        where: { accountId: acc.id },
        _count: true,
      });

      const statusCounts: Record<string, number> = {};
      for (const c of counts) {
        statusCounts[c.status] = c._count;
      }

      return {
        ...acc,
        draft: statusCounts["draft"] || 0,
        queued: statusCounts["queued"] || 0,
        posted: statusCounts["posted"] || 0,
        error: statusCounts["error"] || 0,
        total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      };
    })
  );

  return NextResponse.json(stats);
}
