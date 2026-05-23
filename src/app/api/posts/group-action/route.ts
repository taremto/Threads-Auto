import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import {
  cancelByPostId,
  endpointFromAccount,
  pushQueue,
  toJstString,
  updateByPostId,
  type PushPostInput,
} from "@/lib/gas-bridge";
import { hasPostIntervalConflict } from "@/lib/schedule";

/**
 * 同じグループの投稿をまとめてステータス変更 or 削除 or キュー追加 or 単一投稿の本文編集
 * POST body:
 *   { postId, action: "status", status: string }
 *   { postId, action: "delete" }
 *   { postId, action: "queue", publishAt: string }  // ISO日時
 *   { postId, action: "edit", body: string }        // 単一投稿の本文のみ更新
 */
export async function POST(request: Request) {
  try {
    const { postId, action, status, publishAt, body } = await request.json();

    if (!postId || !action) {
      return NextResponse.json(
        { error: "postId and action required" },
        { status: 400 }
      );
    }

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
      return NextResponse.json({ error: "post not found" }, { status: 404 });
    }

    // 単一投稿の本文編集（グループ全体ではない）
    if (action === "edit") {
      if (typeof body !== "string") {
        return NextResponse.json(
          { error: "body required for edit" },
          { status: 400 }
        );
      }
      const trimmed = body.trim();

      // 本文を空にして保存 → その1コマを削除（スレッドを縮める）
      if (trimmed === "") {
        // 同グループの他のコマ数
        const siblings = await prisma.post.count({
          where: {
            accountId: post.accountId,
            groupNo: post.groupNo,
            id: { not: postId },
          },
        });
        if (siblings === 0) {
          return NextResponse.json(
            {
              error:
                "スレッドの最後の1投稿は空にできません。投稿ごと消すなら「削除」ボタンを使ってください。",
            },
            { status: 400 }
          );
        }
        // GASにある投稿（クラウドオフロード中の queued）なら GAS側もキャンセル（失敗してもログして続行）
        if (post.executor === "gas" && post.status !== "posted") {
          const acc = await prisma.account.findUnique({
            where: { id: post.accountId },
          });
          if (acc?.cloudOffloadEnabled) {
            const ep = endpointFromAccount(acc);
            if (ep) {
              const cancelResult = await cancelByPostId(ep, post.id);
              if (!cancelResult.ok) {
                console.warn(
                  `[group-action] GAS cancel失敗 on edit-empty (postId=${post.id}): ${cancelResult.error}`
                );
              }
            }
          }
        }
        await prisma.post.delete({ where: { id: postId } });
        // 残りが1コマだけになったら「単体」投稿に変換
        const remaining = await prisma.post.findMany({
          where: { accountId: post.accountId, groupNo: post.groupNo },
          orderBy: { sortOrder: "asc" },
        });
        if (remaining.length === 1) {
          await prisma.post.update({
            where: { id: remaining[0].id },
            data: { postType: "standalone" },
          });
        }
        return NextResponse.json({
          deleted: true,
          postId,
          remaining: remaining.length,
        });
      }

      // GASにある投稿（executor="gas" かつ queued）はGAS側のテキストも同期
      if (post.executor === "gas" && post.status === "queued") {
        const acc = await prisma.account.findUnique({ where: { id: post.accountId } });
        const ep = acc ? endpointFromAccount(acc) : null;
        if (ep) {
          const gasResult = await updateByPostId(ep, {
            webPostId: post.id,
            text: trimmed,
          });
          if (!gasResult.ok) {
            return NextResponse.json(
              { error: "GAS同期失敗: " + (gasResult.error || "不明") },
              { status: 502 }
            );
          }
        }
      }
      const updated = await prisma.post.update({
        where: { id: postId },
        data: { body: trimmed, charCount: trimmed.length },
      });
      return NextResponse.json({ id: updated.id, body: updated.body, charCount: updated.charCount });
    }

    const groupPosts = await prisma.post.findMany({
      where: { accountId: post.accountId, groupNo: post.groupNo },
    });

    const ids = groupPosts.map((p) => p.id);

    // クラウドオフロード状態を判定
    const account = await prisma.account.findUnique({
      where: { id: post.accountId },
    });
    const cloudEndpoint =
      account?.cloudOffloadEnabled ? endpointFromAccount(account) : null;

    // キューに追加（日時指定付き）
    if (action === "queue" && publishAt) {
      const publishAtDate = new Date(publishAt);
      if (!Number.isFinite(publishAtDate.getTime())) {
        return NextResponse.json(
          { error: "予約日時が正しくありません。もう一度日時を選び直してください。" },
          { status: 400 }
        );
      }

      const busyPosts = await prisma.post.findMany({
        where: {
          accountId: post.accountId,
          id: { notIn: ids },
          OR: [
            { status: "queued", publishAt: { not: null } },
            { status: "posted", postedAt: { not: null } },
          ],
        },
        select: { publishAt: true, postedAt: true },
      });
      const busyTimes = busyPosts
        .map((p) => p.publishAt ?? p.postedAt)
        .filter((d): d is Date => d instanceof Date);
      if (hasPostIntervalConflict(publishAtDate, busyTimes)) {
        return NextResponse.json(
          {
            error:
              "この時間の前後1時間以内に、同じアカウントの予約または投稿があります。暴発防止のため、投稿同士は必ず1時間以上空けてください。",
          },
          { status: 409 }
        );
      }

      if (cloudEndpoint) {
        const postsForGas: PushPostInput[] = groupPosts.map((p) => ({
          webPostId: p.id,
          groupNo: p.groupNo,
          text: p.body,
          postType: p.postType === "thread" ? "thread" : ("standalone" as const),
          publishAtJst: toJstString(publishAtDate),
          memo: p.memo || undefined,
        }));
        const gasResult = await pushQueue(cloudEndpoint, postsForGas);
        if (!gasResult.ok) {
          return NextResponse.json(
            { error: "GASへのPush失敗: " + (gasResult.error || "不明") },
            { status: 502 }
          );
        }
        await prisma.post.updateMany({
          where: { id: { in: ids } },
          data: {
            status: "queued",
            publishAt: publishAtDate,
            executor: "gas",
          },
        });
        return NextResponse.json({
          count: ids.length,
          status: "queued",
          publishAt,
          executor: "gas",
        });
      }

      await prisma.post.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "queued",
          publishAt: publishAtDate,
          executor: "local",
        },
      });
      return NextResponse.json({ count: ids.length, status: "queued", publishAt });
    }

    // ステータス変更
    if (action === "status" && status) {
      const updateData: Record<string, unknown> = { status };
      // 下書きに戻す場合はpublishAtをクリア
      if (status === "draft") {
        updateData.publishAt = null;
        updateData.executor = "local"; // executorも初期化

        // GAS側にqueued中の行があればキャンセル（行は残してstatusを「下書き」へ）
        if (cloudEndpoint) {
          const gasPosts = groupPosts.filter((p) => p.executor === "gas");
          for (const gp of gasPosts) {
            const cancelResult = await cancelByPostId(cloudEndpoint, gp.id);
            // 既に投稿済等の理由で失敗してもログ出して続行（DBはローカルへ戻す）
            if (!cancelResult.ok) {
              console.warn(
                `[group-action] GAS cancel失敗 (postId=${gp.id}): ${cancelResult.error}`
              );
            }
          }
        }
      }
      await prisma.post.updateMany({
        where: { id: { in: ids } },
        data: updateData,
      });
      return NextResponse.json({ count: ids.length, status });
    }

    // 削除
    if (action === "delete") {
      // GAS側にqueued中の行があればキャンセル
      if (cloudEndpoint) {
        const gasPosts = groupPosts.filter(
          (p) => p.executor === "gas" && p.status !== "posted"
        );
        for (const gp of gasPosts) {
          const cancelResult = await cancelByPostId(cloudEndpoint, gp.id);
          if (!cancelResult.ok) {
            console.warn(
              `[group-action] GAS cancel失敗 on delete (postId=${gp.id}): ${cancelResult.error}`
            );
          }
        }
      }
      await prisma.post.deleteMany({
        where: { id: { in: ids } },
      });
      return NextResponse.json({ count: ids.length, deleted: true });
    }

    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  } catch (e) {
    console.error("group-action error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
