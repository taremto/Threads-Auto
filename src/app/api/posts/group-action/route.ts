import { prisma } from "@/lib/prisma";
import { validateObservedThreadsUserId } from "@/lib/account-identity";
import type { Post } from "@prisma/client";
import { NextResponse } from "next/server";

const LAYER_TAG_RE = /^\[L[123]\]\s*\n?/;
function stripLayerTag(s: string): string {
  return s.replace(LAYER_TAG_RE, "");
}
import {
  cancelByPostId,
  deleteMedia,
  endpointFromAccount,
  gasVersionUpgradeMessage,
  healthCheck,
  isGasVersionSupported,
  pushQueue,
  tokenFingerprintOf,
  toJstString,
  updateByPostId,
  verifyQueueByPostIds,
  type PushPostInput,
} from "@/lib/gas-bridge";
import { hasPostIntervalConflict } from "@/lib/schedule";

const MIN_RESERVATION_LEAD_MS = 60_000;

function sortGroupPosts(a: Post, b: Post) {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

function mutableTargetsFor(selected: Post, groupPosts: Post[]) {
  const sorted = [...groupPosts].sort(sortGroupPosts);
  const hasPosted = sorted.some((p) => p.status === "posted");
  if (!hasPosted) return sorted;

  const selectedIndex = sorted.findIndex((p) => p.id === selected.id);
  if (selectedIndex < 0 || selected.status === "posted") return [];

  // ツリーの前半が投稿済みの場合は、投稿済み部分を絶対に触らない。
  // 選択した失敗/未投稿コマ以降だけを再試行・下書き化・削除の対象にする。
  return sorted.slice(selectedIndex).filter((p) => p.status !== "posted");
}

function ceilToNextMinute(date: Date) {
  const next = new Date(date);
  if (next.getSeconds() > 0 || next.getMilliseconds() > 0) {
    next.setMinutes(next.getMinutes() + 1);
  }
  next.setSeconds(0, 0);
  return next;
}

function nextSafeRetryAt(busyTimes: Date[]) {
  let candidate = ceilToNextMinute(
    new Date(Date.now() + Math.max(MIN_RESERVATION_LEAD_MS, 2 * 60_000))
  );
  for (let i = 0; i < 14 * 24 * 60; i++) {
    if (!hasPostIntervalConflict(candidate, busyTimes)) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Error(
    "安全に再試行できる空き時間が見つかりませんでした。既存の予約を確認してから、手動で時刻を変更してください。"
  );
}

/**
 * 同じグループの投稿をまとめてステータス変更 or 削除 or キュー追加 or 単一投稿の本文編集
 * POST body:
 *   { postId, action: "status", status: string }
 *   { postId, action: "delete" }
 *   { postId, action: "queue", publishAt: string }  // ISO日時
 *   { postId, action: "reschedule", publishAt: string }  // queued投稿の日時変更
 *   { postId, action: "edit", body: string, revisionInstructions?: [...] }
 *     // 単一投稿の本文更新。AI修正指示があればナレッジ反映候補も同時保存
 */
export async function POST(request: Request) {
  try {
    const {
      postId,
      action,
      status,
      publishAt,
      body,
      revisionInstructions,
    } = await request.json();

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
      const normalizedRevisionInstructions = Array.isArray(
        revisionInstructions
      )
        ? revisionInstructions
            .map((item: unknown) => {
              if (!item || typeof item !== "object") return null;
              const candidate = item as Record<string, unknown>;
              const instruction =
                typeof candidate.instruction === "string"
                  ? candidate.instruction.trim().slice(0, 2_000)
                  : "";
              if (!instruction) return null;
              return {
                instruction,
                beforeBody:
                  typeof candidate.beforeBody === "string"
                    ? candidate.beforeBody.slice(0, 5_000)
                    : post.body,
                afterBody:
                  typeof candidate.afterBody === "string"
                    ? candidate.afterBody.slice(0, 5_000)
                    : trimmed,
              };
            })
            .filter(
              (
                item
              ): item is {
                instruction: string;
                beforeBody: string;
                afterBody: string;
              } => item !== null
            )
            .slice(0, 20)
        : [];

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
      const updated = await prisma.$transaction(async (tx) => {
        const savedPost = await tx.post.update({
          where: { id: postId },
          data: { body: trimmed, charCount: trimmed.length },
        });
        for (const revision of normalizedRevisionInstructions) {
          const duplicate =
            await tx.knowledgeRevisionSuggestion.findFirst({
              where: {
                postId,
                status: "pending",
                instruction: revision.instruction,
                afterBody: revision.afterBody,
              },
              select: { id: true },
            });
          if (duplicate) continue;
          await tx.knowledgeRevisionSuggestion.create({
            data: {
              accountId: post.accountId,
              postId,
              instruction: revision.instruction,
              beforeBody: revision.beforeBody,
              afterBody: revision.afterBody,
            },
          });
        }
        return savedPost;
      });
      return NextResponse.json({
        id: updated.id,
        body: updated.body,
        charCount: updated.charCount,
        knowledgeSuggestionsCreated: normalizedRevisionInstructions.length,
      });
    }

    const groupPosts = await prisma.post.findMany({
      where: { accountId: post.accountId, groupNo: post.groupNo },
      include: {
        media: { where: { status: "ready" }, orderBy: { sortOrder: "asc" } },
      },
    });

    const sortedGroupPosts = [...groupPosts].sort(sortGroupPosts);
    const mutableTargets = mutableTargetsFor(post, sortedGroupPosts);
    const mutableIds = mutableTargets.map((p) => p.id);
    // 添付画像（status="ready"のみ）を postId 単位で引けるようにする（GAS push時に使う）
    const mediaByPostId = new Map<string, string[]>(
      groupPosts.map((g) => [g.id, g.media.map((m) => m.publicUrl).filter(Boolean)])
    );

    if (
      ["queue", "reschedule", "retryFailed", "failedToDraft", "delete"].includes(action) ||
      (action === "status" && status === "draft")
    ) {
      if (mutableIds.length === 0) {
        return NextResponse.json(
          {
            error:
              "投稿済みの投稿は変更できません。ツリーの途中で失敗している場合は、赤いエラー行から操作してください。",
          },
          { status: 409 }
        );
      }
    }

    // クラウドオフロード状態を判定
    const account = await prisma.account.findUnique({
      where: { id: post.accountId },
    });
    if (!account) {
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    }
    const cloudEndpoint = account.cloudOffloadEnabled
      ? endpointFromAccount(account)
      : null;

    // キューに追加 / キュー済み投稿の日時変更（日時指定付き）
    if ((action === "queue" || action === "reschedule") && publishAt) {
      const migrationLock = await prisma.appSetting.findUnique({
        where: { key: "migrationLock" },
      });
      if (migrationLock?.value === "true") {
        return NextResponse.json(
          {
            error:
              "Google投稿の修復中です。修復が終わってからもう一度キューに追加してください。",
          },
          { status: 409 }
        );
      }
      const publishAtDate = new Date(publishAt);
      if (!Number.isFinite(publishAtDate.getTime())) {
        return NextResponse.json(
          { error: "予約日時が正しくありません。もう一度日時を選び直してください。" },
          { status: 400 }
        );
      }
      if (publishAtDate.getTime() < Date.now() + MIN_RESERVATION_LEAD_MS) {
        return NextResponse.json(
          {
            error:
              "過去の時刻、または直前すぎる時刻には予約できません。今より1分以上あとの日時を選んでください。",
          },
          { status: 400 }
        );
      }
      if (action === "reschedule") {
        const notQueued = mutableTargets.filter((p) => p.status !== "queued");
        if (notQueued.length > 0) {
          return NextResponse.json(
            {
              error:
                "予約中の投稿だけ時刻を変更できます。投稿済みや下書きは変更できません。",
            },
            { status: 409 }
          );
        }
      }

      const busyPosts = await prisma.post.findMany({
        where: {
          accountId: post.accountId,
          id: { notIn: mutableIds },
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
        const gasHealth = await healthCheck(cloudEndpoint);
        if (!gasHealth.ok || !gasHealth.data) {
          return NextResponse.json(
            {
              error:
                "Google側に接続できないため、予約をクラウドへ送れませんでした。ネット接続とクラウドオフロード設定を確認してください。",
              detail: gasHealth.error,
            },
            { status: 502 }
          );
        }
        if (!isGasVersionSupported(gasHealth.data.version)) {
          return NextResponse.json(
            { error: gasVersionUpgradeMessage(gasHealth.data.version) },
            { status: 422 }
          );
        }
        if (!gasHealth.data.configured) {
          return NextResponse.json(
            { error: "Google側の初期設定が未完了です。設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。" },
            { status: 422 }
          );
        }
        if (gasHealth.data.scriptTimeZone && gasHealth.data.scriptTimeZone !== "Asia/Tokyo") {
          return NextResponse.json(
            { error: "Google側のタイムゾーンが Asia/Tokyo ではありません。設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。" },
            { status: 422 }
          );
        }
        if (!gasHealth.data.hasTrigger) {
          return NextResponse.json(
            { error: "Google側の自動実行が見つかりません。設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。" },
            { status: 422 }
          );
        }
        const identityCheck = await validateObservedThreadsUserId(
          {
            accountId: account.id,
            accountName: account.name,
            currentThreadsUserId: account.threadsUserId,
          },
          gasHealth.data.userId
        );
        if (!identityCheck.ok) {
          return NextResponse.json(
            {
              error: identityCheck.error,
              expected: {
                userId: identityCheck.expectedUserId,
                tokenFingerprint: tokenFingerprintOf(account.accessToken),
              },
              observed: {
                userId: identityCheck.observedUserId,
                tokenFingerprint: gasHealth.data.tokenFingerprint || null,
                version: gasHealth.data.version,
              },
            },
            { status: 409 }
          );
        }
        if (identityCheck.shouldBackfill) {
          await prisma.account.update({
            where: { id: account.id },
            data: { threadsUserId: identityCheck.userId },
          });
        }
        const postsForGas: PushPostInput[] = mutableTargets.map((p) => {
          const imageUrls = mediaByPostId.get(p.id) ?? [];
          return {
            webPostId: p.id,
            groupNo: p.groupNo,
            text: stripLayerTag(p.body),
            postType: p.postType === "thread" ? "thread" : ("standalone" as const),
            publishAtJst: toJstString(publishAtDate),
            memo: p.memo || undefined,
            ...(imageUrls.length > 0 ? { imageUrls } : {}),
          };
        });
        const gasResult = await pushQueue(cloudEndpoint, postsForGas);
        if (!gasResult.ok) {
          return NextResponse.json(
            { error: "GASへのPush失敗: " + (gasResult.error || "不明") },
            { status: 502 }
          );
        }
        const queueCheck = await verifyQueueByPostIds(
          cloudEndpoint,
          postsForGas.map((p) => p.webPostId)
        );
        if (!queueCheck.ok || !queueCheck.data) {
          return NextResponse.json(
            {
              error:
                "Google側に予約が入ったか確認できませんでした。Web画面では予約済みにしませんでした。もう一度お試しください。",
              detail: queueCheck.error,
            },
            { status: 502 }
          );
        }
        if (queueCheck.data.missing.length > 0) {
          return NextResponse.json(
            {
              error:
                "Google側に入っていない予約があります。Web画面では予約済みにしませんでした。もう一度お試しください。",
              missing: queueCheck.data.missing.length,
            },
            { status: 502 }
          );
        }
        const notWaiting = queueCheck.data.rows.filter((r) => r.status !== "待機中");
        if (notWaiting.length > 0) {
          return NextResponse.json(
            {
              error:
                "Google側の予約状態が待機中ではありません。重複投稿を避けるため停止しました。今すぐ同期して状態を確認してください。",
            },
            { status: 409 }
          );
        }
        await prisma.post.updateMany({
          where: { id: { in: mutableIds } },
          data: {
            status: "queued",
            publishAt: publishAtDate,
            executor: "gas",
            error: null,
          },
        });
        return NextResponse.json({
          count: mutableIds.length,
          status: "queued",
          publishAt,
          executor: "gas",
        });
      }

      await prisma.post.updateMany({
        where: { id: { in: mutableIds } },
        data: {
          status: "queued",
          publishAt: publishAtDate,
          executor: "local",
          error: null,
        },
      });
      return NextResponse.json({ count: mutableIds.length, status: "queued", publishAt });
    }

    // ツリー投稿の途中失敗を、投稿済みの親投稿を触らずに続きだけ再試行する。
    if (action === "retryFailed") {
      if (!mutableTargets.some((p) => p.status === "error")) {
        return NextResponse.json(
          { error: "再試行できるエラー投稿が見つかりませんでした。" },
          { status: 409 }
        );
      }

      const busyPosts = await prisma.post.findMany({
        where: {
          accountId: post.accountId,
          id: { notIn: mutableIds },
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
      const retryAt = nextSafeRetryAt(busyTimes);

      if (cloudEndpoint) {
        const gasHealth = await healthCheck(cloudEndpoint);
        if (!gasHealth.ok || !gasHealth.data) {
          return NextResponse.json(
            {
              error:
                "Google側に接続できないため、失敗分の再試行を予約できませんでした。ネット接続とクラウドオフロード設定を確認してください。",
              detail: gasHealth.error,
            },
            { status: 502 }
          );
        }
        if (!isGasVersionSupported(gasHealth.data.version)) {
          return NextResponse.json(
            { error: gasVersionUpgradeMessage(gasHealth.data.version) },
            { status: 422 }
          );
        }
        if (!gasHealth.data.configured) {
          return NextResponse.json(
            { error: "Google側の初期設定が未完了です。設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。" },
            { status: 422 }
          );
        }
        if (gasHealth.data.scriptTimeZone && gasHealth.data.scriptTimeZone !== "Asia/Tokyo") {
          return NextResponse.json(
            { error: "Google側のタイムゾーンが Asia/Tokyo ではありません。設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。" },
            { status: 422 }
          );
        }
        if (!gasHealth.data.hasTrigger) {
          return NextResponse.json(
            { error: "Google側の自動実行が見つかりません。設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。" },
            { status: 422 }
          );
        }
        const identityCheck = await validateObservedThreadsUserId(
          {
            accountId: account.id,
            accountName: account.name,
            currentThreadsUserId: account.threadsUserId,
          },
          gasHealth.data.userId
        );
        if (!identityCheck.ok) {
          return NextResponse.json(
            {
              error: identityCheck.error,
              expected: {
                userId: identityCheck.expectedUserId,
                tokenFingerprint: tokenFingerprintOf(account.accessToken),
              },
              observed: {
                userId: identityCheck.observedUserId,
                tokenFingerprint: gasHealth.data.tokenFingerprint || null,
                version: gasHealth.data.version,
              },
            },
            { status: 409 }
          );
        }
        if (identityCheck.shouldBackfill) {
          await prisma.account.update({
            where: { id: account.id },
            data: { threadsUserId: identityCheck.userId },
          });
        }
        const postsForGas: PushPostInput[] = mutableTargets.map((p) => {
          const imageUrls = mediaByPostId.get(p.id) ?? [];
          return {
            webPostId: p.id,
            groupNo: p.groupNo,
            text: stripLayerTag(p.body),
            postType: p.postType === "thread" ? "thread" : ("standalone" as const),
            publishAtJst: toJstString(retryAt),
            memo: p.memo || undefined,
            ...(imageUrls.length > 0 ? { imageUrls } : {}),
          };
        });
        const gasResult = await pushQueue(cloudEndpoint, postsForGas);
        if (!gasResult.ok) {
          return NextResponse.json(
            { error: "GASへのPush失敗: " + (gasResult.error || "不明") },
            { status: 502 }
          );
        }
        const queueCheck = await verifyQueueByPostIds(
          cloudEndpoint,
          postsForGas.map((p) => p.webPostId)
        );
        if (!queueCheck.ok || !queueCheck.data) {
          return NextResponse.json(
            {
              error:
                "Google側に予約が入ったか確認できませんでした。Web画面では予約済みにしませんでした。もう一度お試しください。",
              detail: queueCheck.error,
            },
            { status: 502 }
          );
        }
        if (queueCheck.data.missing.length > 0) {
          return NextResponse.json(
            {
              error:
                "Google側に入っていない予約があります。Web画面では予約済みにしませんでした。もう一度お試しください。",
              missing: queueCheck.data.missing.length,
            },
            { status: 502 }
          );
        }
        const notWaiting = queueCheck.data.rows.filter((r) => r.status !== "待機中");
        if (notWaiting.length > 0) {
          return NextResponse.json(
            {
              error:
                "Google側の予約状態が待機中ではありません。重複投稿を避けるため停止しました。今すぐ同期して状態を確認してください。",
            },
            { status: 409 }
          );
        }
        await prisma.post.updateMany({
          where: { id: { in: mutableIds } },
          data: {
            status: "queued",
            publishAt: retryAt,
            executor: "gas",
            error: null,
            retryCount: 0,
          },
        });
        return NextResponse.json({
          count: mutableIds.length,
          status: "queued",
          publishAt: retryAt.toISOString(),
          executor: "gas",
          partialRetry: true,
        });
      }

      await prisma.post.updateMany({
        where: { id: { in: mutableIds } },
        data: {
          status: "queued",
          publishAt: retryAt,
          executor: "local",
          error: null,
          retryCount: 0,
        },
      });
      return NextResponse.json({
        count: mutableIds.length,
        status: "queued",
        publishAt: retryAt.toISOString(),
        executor: "local",
        partialRetry: true,
      });
    }

    // ステータス変更
    if ((action === "status" && status) || action === "failedToDraft") {
      const nextStatus = action === "failedToDraft" ? "draft" : String(status);
      const updateData: Record<string, unknown> = { status: nextStatus };
      // 下書きに戻す場合はpublishAtをクリア
      if (nextStatus === "draft") {
        updateData.publishAt = null;
        updateData.executor = "local"; // executorも初期化
        updateData.error = null;
        updateData.threadsPostId = null;
        updateData.postUrl = null;
        updateData.postedAt = null;

        // GAS側にqueued中の行があればキャンセル（行は残してstatusを「下書き」へ）
        if (cloudEndpoint) {
          const gasPosts = mutableTargets.filter((p) => p.executor === "gas");
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
        where: { id: { in: mutableIds } },
        data: updateData,
      });
      return NextResponse.json({ count: mutableIds.length, status: nextStatus });
    }

    // 削除
    if (action === "delete") {
      // 削除する投稿に紐づくDrive画像を、行を消す前に控えておく（あとでゴミ箱へ）
      const mediaToTrash = cloudEndpoint
        ? await prisma.postMedia.findMany({
            where: { postId: { in: mutableIds }, driveFileId: { not: null } },
            select: { driveFileId: true },
          })
        : [];

      // GAS側にqueued中の行があればキャンセル
      if (cloudEndpoint) {
        const gasPosts = mutableTargets.filter(
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
        where: { id: { in: mutableIds } },
      });

      // 投稿を消したら、その画像もDriveからゴミ箱へ（ベストエフォート・旧GAS/失敗は無視）
      if (cloudEndpoint && mediaToTrash.length > 0) {
        const ids = mediaToTrash
          .map((m) => m.driveFileId)
          .filter((x): x is string => !!x);
        await deleteMedia(cloudEndpoint, ids).catch(() => {});
      }

      return NextResponse.json({ count: mutableIds.length, deleted: true });
    }

    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  } catch (e) {
    console.error("group-action error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
