import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseAnalyticsCsv } from "@/lib/insights/csv-import";

// 既存スプシ分析CSV(20列)を HistoricalPost に取り込む（冪等upsert）
// body: { accountId: string, csvText: string }
export async function POST(request: Request) {
  try {
    const { accountId, csvText } = await request.json();
    if (!accountId || typeof accountId !== "string") {
      return NextResponse.json({ error: "accountId is required" }, { status: 400 });
    }
    if (!csvText || typeof csvText !== "string") {
      return NextResponse.json({ error: "csvText is required" }, { status: 400 });
    }

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) {
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    }

    const records = parseAnalyticsCsv(csvText);
    if (records.length === 0) {
      return NextResponse.json({ error: "有効な行がありませんでした", imported: 0 });
    }

    const CHUNK = 200;
    let upserted = 0;
    let created = 0;

    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const ops = chunk.map((r) => {
        const data = {
          accountId,
          threadsPostId: r.threadsPostId,
          postedAt: r.postedAt,
          text: r.text,
          postUrl: r.postUrl,
          views: r.views,
          likes: r.likes,
          replies: r.replies,
          reposts: r.reposts,
          quotes: r.quotes,
          er: r.er,
          treeBody: r.treeBody,
          treeCount: r.treeCount,
          tag: r.tag,
          perfLabel: r.perfLabel,
          source: "csv",
        };
        if (r.threadsPostId) {
          upserted++;
          return prisma.historicalPost.upsert({
            where: {
              accountId_threadsPostId: {
                accountId,
                threadsPostId: r.threadsPostId,
              },
            },
            create: data,
            update: data,
          });
        }
        created++;
        return prisma.historicalPost.create({ data });
      });
      await prisma.$transaction(ops);
    }

    const total = await prisma.historicalPost.count({ where: { accountId } });

    return NextResponse.json({
      ok: true,
      parsed: records.length,
      upserted,
      created,
      totalForAccount: total,
    });
  } catch (e) {
    return NextResponse.json(
      { error: String((e as Error)?.message || e) },
      { status: 500 }
    );
  }
}
