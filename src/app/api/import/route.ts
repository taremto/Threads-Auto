import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { parsePosts } from "@/lib/post-parser";

/**
 * v3 batch ファイル等のテキストをパースして投稿をDBに投入
 * POST body: { accountId, text, batchFile? }
 */
export async function POST(request: Request) {
  const { accountId, text, batchFile } = await request.json();

  if (!accountId || !text) {
    return NextResponse.json(
      { error: "accountId and text required" },
      { status: 400 }
    );
  }

  const posts = parsePosts(text);
  if (posts.length === 0) {
    return NextResponse.json(
      {
        error:
          "投稿を読み取れませんでした。各スレッドは「=====」で区切り、各投稿は行頭に「■1」「■2」を付けてください。",
      },
      { status: 400 }
    );
  }

  // 現在の最大groupNo / sortOrder を取得
  const [maxGroup, maxSort] = await Promise.all([
    prisma.post.aggregate({ where: { accountId }, _max: { groupNo: true } }),
    prisma.post.aggregate({ where: { accountId }, _max: { sortOrder: true } }),
  ]);
  let groupNo = (maxGroup._max.groupNo ?? 0) + 1;
  let sortOrder = (maxSort._max.sortOrder ?? 0) + 1;

  const data = [];
  for (const post of posts) {
    if (post.thread && post.items.length > 1) {
      for (const item of post.items) {
        data.push({
          accountId,
          groupNo,
          body: item,
          postType: "thread",
          charCount: item.length,
          status: "draft",
          batchFile: batchFile || null,
          sortOrder: sortOrder++,
        });
      }
    } else {
      const body = post.items[0] ?? "";
      data.push({
        accountId,
        groupNo,
        body,
        postType: "standalone",
        charCount: body.length,
        status: "draft",
        batchFile: batchFile || null,
        sortOrder: sortOrder++,
      });
    }
    groupNo++;
  }

  const result = await prisma.post.createMany({ data });
  return NextResponse.json(
    { count: result.count, posts: posts.length },
    { status: 201 }
  );
}
