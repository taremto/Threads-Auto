import { prisma } from "@/lib/prisma";
import { publishStandalone, publishThread } from "@/lib/threads-api";
import { NextResponse } from "next/server";

/**
 * 投稿をThreads APIで公開する
 * POST body: { postId }
 * - standalone: 単体投稿
 * - thread: 同じgroupNoの投稿をまとめてスレッド投稿
 */
export async function POST(request: Request) {
  try {
    const { postId } = await request.json();

    if (!postId) {
      return NextResponse.json({ error: "postId required" }, { status: 400 });
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { account: true },
    });

    if (!post) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    const { account } = post;

    // クラウドオフロード中は投稿実行の権威がGASにあるため、Webからの手動投稿は拒否
    if (account.cloudOffloadEnabled || post.executor === "gas") {
      return NextResponse.json(
        {
          error:
            "クラウドオフロードがONのため、Webアプリからの手動投稿はできません。スプシ＋GAS側で実行されます。",
        },
        { status: 409 }
      );
    }

    if (!account.accessToken || !account.threadsUserId) {
      return NextResponse.json(
        { error: "Account not configured: missing token or userId" },
        { status: 400 }
      );
    }

    // 凍結対策: 同一アカウントの直近投稿から1時間以上経過しているかチェック
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentPost = await prisma.post.findFirst({
      where: {
        accountId: account.id,
        status: "posted",
        postedAt: { gt: oneHourAgo },
      },
      orderBy: { postedAt: "desc" },
    });

    if (recentPost) {
      const nextAllowed = new Date(recentPost.postedAt!.getTime() + 60 * 60 * 1000);
      return NextResponse.json(
        {
          error: `凍結対策: 前回投稿から1時間以上空ける必要があります。次回投稿可能: ${nextAllowed.toLocaleTimeString("ja-JP")}`,
          nextAllowedAt: nextAllowed.toISOString(),
        },
        { status: 429 }
      );
    }

    // 同じグループの投稿を取得
    const groupPosts = await prisma.post.findMany({
      where: { accountId: account.id, groupNo: post.groupNo },
      orderBy: { sortOrder: "asc" },
    });

    const ids = groupPosts.map((p) => p.id);
    let result;

    if (post.postType === "thread" && groupPosts.length > 1) {
      // スレッド投稿
      const items = groupPosts.map((p) => p.body);
      result = await publishThread(
        account.threadsUserId,
        account.accessToken,
        items
      );
    } else {
      // 単体投稿
      result = await publishStandalone(
        account.threadsUserId,
        account.accessToken,
        post.body
      );
    }

    if (result.ok) {
      // 成功: 全投稿を posted に
      await prisma.post.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "posted",
          threadsPostId: result.threadsPostId || null,
          postUrl: result.postUrl || null,
          postedAt: new Date(),
        },
      });

      return NextResponse.json({
        ok: true,
        threadsPostId: result.threadsPostId,
        postUrl: result.postUrl,
      });
    } else {
      // 失敗: error ステータスに
      await prisma.post.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "error",
          error: result.error || "Unknown error",
        },
      });

      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 502 }
      );
    }
  } catch (e) {
    console.error("threads/publish error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
