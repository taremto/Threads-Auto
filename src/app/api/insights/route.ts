import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { aggregate, type AnalyticsItem } from "@/lib/insights/aggregate";

// アカウント別分析データを返す（Post + HistoricalPost をマージして集計）
// GET /api/insights?accountId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const accountId = searchParams.get("accountId");
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const fromStr = searchParams.get("from");
  const toStr = searchParams.get("to");
  const from = fromStr ? new Date(fromStr) : null;
  const to = toStr ? new Date(toStr) : null;
  const inRange = (d: Date | null): boolean => {
    if (!d) return true; // postedAt不明は除外しない（status集計に使う）
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, name: true, insightsEnabled: true, insightsLastFetchedAt: true },
  });
  if (!account) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const [posts, historical] = await Promise.all([
    prisma.post.findMany({
      where: { accountId },
      select: {
        id: true,
        threadsPostId: true,
        status: true,
        postedAt: true,
        body: true,
        postUrl: true,
        lastViews: true,
        lastLikes: true,
        lastReplies: true,
        lastReposts: true,
        lastQuotes: true,
        lastEr: true,
      },
    }),
    prisma.historicalPost.findMany({
      where: { accountId },
      select: {
        id: true,
        threadsPostId: true,
        postedAt: true,
        text: true,
        postUrl: true,
        views: true,
        likes: true,
        replies: true,
        reposts: true,
        quotes: true,
        er: true,
      },
    }),
  ]);

  // 突合キー: 内部Postが持つ threadsPostId は Historical 側で重複させない
  const internalThreadsIds = new Set(
    posts.map((p) => p.threadsPostId).filter((x): x is string => !!x)
  );

  const items: AnalyticsItem[] = [];

  for (const p of posts) {
    if (!inRange(p.postedAt)) continue;
    items.push({
      key: p.id,
      threadsPostId: p.threadsPostId,
      source: "post",
      status: p.status,
      postedAt: p.postedAt,
      text: p.body,
      postUrl: p.postUrl,
      views: p.lastViews,
      likes: p.lastLikes,
      replies: p.lastReplies,
      reposts: p.lastReposts,
      quotes: p.lastQuotes,
      er: p.lastEr,
    });
  }

  for (const h of historical) {
    if (h.threadsPostId && internalThreadsIds.has(h.threadsPostId)) continue;
    if (!inRange(h.postedAt)) continue;
    items.push({
      key: h.id,
      threadsPostId: h.threadsPostId,
      source: "historical",
      status: "posted",
      postedAt: h.postedAt,
      text: h.text,
      postUrl: h.postUrl,
      views: h.views,
      likes: h.likes,
      replies: h.replies,
      reposts: h.reposts,
      quotes: h.quotes,
      er: h.er,
    });
  }

  const result = aggregate(items);

  // データが実在する範囲（期間フィルタ前の全データの postedAt min/max）。空状態の案内に使う。
  let minT = Infinity;
  let maxT = -Infinity;
  let hasDate = false;
  const consider = (d: Date | null) => {
    if (!d) return;
    const t = d.getTime();
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
    hasDate = true;
  };
  for (const p of posts) consider(p.postedAt);
  for (const h of historical) consider(h.postedAt);
  const availableRange = hasDate
    ? { from: new Date(minT).toISOString(), to: new Date(maxT).toISOString() }
    : { from: null, to: null };

  return NextResponse.json({
    accountId,
    accountName: account.name,
    degraded: account.insightsEnabled === false,
    insightsLastFetchedAt: account.insightsLastFetchedAt,
    historicalCount: historical.length,
    availableRange,
    ...result,
  });
}
