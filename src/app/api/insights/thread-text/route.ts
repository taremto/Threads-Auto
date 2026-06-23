import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchTreeTexts } from "@/lib/insights/threads-insights-api";

/**
 * 高パフォ投稿の「ナレッジ化」で、ツリー全文を解決して返す。
 * 分析の候補はツリーの各コマが別行（別 Post / HistoricalPost）として出るため、
 * ナレッジ化時に全文へまとめ直す。
 *
 * POST { accountId, key, source } -> { text }
 *  - source="post"      : Post.id(key) → groupNo → 同グループの body を sortOrder順で連結
 *  - source="historical": HistoricalPost.id(key) →
 *        ① treeBody(取込済みツリー本文)があればそれ
 *        ② 無ければ Threads API で自分のリプライ連鎖を取得して全文再構成（取れたらtreeBodyにキャッシュ）
 *        ③ それも無理なら単体 text
 *
 * accountId でスコープし、他アカウントのスレッドは解決できないようにする。
 */
export async function POST(request: Request) {
  try {
    const { accountId, key, source } = (await request.json()) as {
      accountId?: string;
      key?: string;
      source?: "post" | "historical";
    };
    if (!accountId || !key) {
      return NextResponse.json(
        { error: "accountId and key required" },
        { status: 400 }
      );
    }

    if (source === "historical") {
      const h = await prisma.historicalPost.findFirst({
        where: { id: key, accountId },
        select: { id: true, threadsPostId: true, treeBody: true, text: true },
      });
      if (!h) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }

      // ① 取込済みのツリー本文があれば即返す
      if (h.treeBody && h.treeBody.trim()) {
        return NextResponse.json({ text: h.treeBody, source: "treeBody" });
      }

      // ② Threads API で自分のリプライ連鎖を辿って全文を再構成（取れたら永続キャッシュ）
      if (h.threadsPostId) {
        const account = await prisma.account.findUnique({
          where: { id: accountId },
          select: { accessToken: true, threadsUsername: true },
        });
        if (account?.accessToken && account.threadsUsername) {
          try {
            const replies = await fetchTreeTexts(
              h.threadsPostId,
              account.accessToken,
              account.threadsUsername
            );
            if (replies.length > 0) {
              const full = [h.text, ...replies]
                .map((t) => (t || "").trim())
                .filter(Boolean)
                .join("\n\n");
              // 次回以降は即・永続（再フェッチ不要）
              await prisma.historicalPost
                .update({
                  where: { id: h.id },
                  data: { treeBody: full, treeCount: replies.length + 1 },
                })
                .catch(() => {});
              return NextResponse.json({ text: full, source: "fetched" });
            }
          } catch {
            /* フォールバックへ */
          }
        }
      }

      // ③ どれも無理なら単体テキスト（従来挙動・壊さない）
      return NextResponse.json({ text: h.text, source: "single" });
    }

    // source="post"（既定）: グループ全コマを sortOrder順に連結＝ツリー全文
    const root = await prisma.post.findFirst({
      where: { id: key, accountId },
      select: { groupNo: true },
    });
    if (!root) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const groupPosts = await prisma.post.findMany({
      where: { accountId, groupNo: root.groupNo },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { body: true },
    });
    const text = groupPosts.map((p) => p.body).join("\n\n");
    return NextResponse.json({ text, source: "group" });
  } catch (e) {
    return NextResponse.json(
      { error: String((e as Error)?.message || e) },
      { status: 500 }
    );
  }
}
