import { prisma } from "@/lib/prisma";
import { validateObservedThreadsUserId } from "@/lib/account-identity";
import { NextResponse } from "next/server";
import {
  endpointFromAccount,
  gasVersionUpgradeMessage,
  healthCheck,
  isGasVersionSupported,
  pushQueue,
  tokenFingerprintOf,
  toJstString,
  verifyQueueByPostIds,
  type PushPostInput,
} from "@/lib/gas-bridge";
import { applyMinuteJitter, buildJstSlots, selectSafeSlots } from "@/lib/schedule";

/**
 * 下書き全件をキューに追加し、アカウントの postingHours に沿って投稿時刻を自動割当
 * POST body: { accountId, dryRun?: boolean }
 *
 * 割当ルール:
 *   - groupNo単位で1スロット消費（スレッドは親も子も同じpublishAt）
 *   - postingHoursをソートして、現在時刻より後の次スロットから順に割当
 *   - その日のスロットを使い切ったら翌日の最初のスロットへ
 *   - 同一スロット内で複数groupは入れない（最低でも postingHours 間隔）
 *   - 最低65分間隔を保証（凍結対策の60分間隔チェックに余裕を持たせる）
 */
export async function POST(request: Request) {
  try {
    const { accountId, dryRun = false } = await request.json();

    if (!accountId) {
      return NextResponse.json({ error: "accountId required" }, { status: 400 });
    }

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) {
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    }
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

    let postingHours: number[];
    try {
      postingHours = JSON.parse(account.postingHours);
      if (!Array.isArray(postingHours) || postingHours.length === 0) {
        throw new Error("invalid postingHours");
      }
      postingHours = [...new Set(postingHours)].sort((a, b) => a - b);
    } catch {
      postingHours = [6, 12, 18, 21];
    }

    const drafts = await prisma.post.findMany({
      where: { accountId, status: "draft" },
      orderBy: [{ groupNo: "asc" }, { sortOrder: "asc" }],
      include: {
        media: { where: { status: "ready" }, orderBy: { sortOrder: "asc" } },
      },
    });

    if (drafts.length === 0) {
      return NextResponse.json({ count: 0, groups: 0, message: "下書きがありません" });
    }

    // groupNoごとにグループ化
    const groupMap = new Map<number, typeof drafts>();
    for (const p of drafts) {
      const arr = groupMap.get(p.groupNo) || [];
      arr.push(p);
      groupMap.set(p.groupNo, arr);
    }
    const groups = Array.from(groupMap.entries()).sort((a, b) => a[0] - b[0]);

    const busyPosts = await prisma.post.findMany({
      where: {
        accountId,
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

    // スロット生成（日本時間固定。PCが海外タイムゾーンでも投稿時刻をずらさない）
    // 既存の予約/投稿から前後60分以内の枠は除外し、暴発を予約時点で防ぐ。
    const candidateCount = Math.max(groups.length + busyTimes.length + 60, groups.length * 4);
    const baseSlots = buildJstSlots(new Date(), postingHours, candidateCount);
    const candidateSlots = applyMinuteJitter(
      baseSlots,
      account.scheduleJitterMinutes ?? 15
    );
    const slots = selectSafeSlots(candidateSlots, busyTimes, groups.length);

    if (slots.length < groups.length) {
      return NextResponse.json(
        {
          error:
            `安全に予約できる投稿枠が足りません（必要${groups.length}件、確保${slots.length}件）。` +
            "既存の予約と前後1時間以上空くように、投稿時間帯を増やすか日を分けて予約してください。",
        },
        { status: 500 }
      );
    }

    const assignments = groups.map(([groupNo, posts], i) => ({
      groupNo,
      postIds: posts.map((p) => p.id),
      publishAt: slots[i],
      preview: posts[0].body.slice(0, 60).replace(/\n/g, " "),
      recommendedLabel: posts[0].recommendedLabel,
    }));

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        count: drafts.length,
        groups: groups.length,
        assignments: assignments.map((a) => ({
          groupNo: a.groupNo,
          publishAt: a.publishAt.toISOString(),
          preview: a.preview,
          recommendedLabel: a.recommendedLabel,
        })),
      });
    }

    // クラウドオフロード時はGASにPush → 成功した分だけ executor="gas" でDB更新
    const endpoint = account.cloudOffloadEnabled ? endpointFromAccount(account) : null;
    if (account.cloudOffloadEnabled && !endpoint) {
      return NextResponse.json(
        {
          error:
            "クラウド投稿がONですが、Google側の接続情報が見つかりません。設定のクラウドオフロード欄で「Google投稿を修復する」を押してください。",
        },
        { status: 400 }
      );
    }

    if (endpoint) {
      const gasHealth = await healthCheck(endpoint);
      if (!gasHealth.ok || !gasHealth.data) {
        return NextResponse.json(
          {
            error:
              "Google側に接続できないため、予約をクラウドへ送れませんでした。ネット接続とクラウドオフロード設定を確認してください。",
            detail: gasHealth.error,
            httpStatus: gasHealth.httpStatus,
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
          accountId,
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
          where: { id: accountId },
          data: { threadsUserId: identityCheck.userId },
        });
      }
      // postId → publishAt の対応表を作る（同groupは同じpublishAt）
      const publishAtByPostId = new Map<string, Date>();
      for (const a of assignments) {
        for (const pid of a.postIds) publishAtByPostId.set(pid, a.publishAt);
      }
      const groupNoByPostId = new Map<string, number>(
        drafts.map((p) => [p.id, p.groupNo])
      );
      const postsForGas: PushPostInput[] = drafts.map((d) => {
        const imageUrls = d.media.map((m) => m.publicUrl).filter(Boolean);
        return {
          webPostId: d.id,
          groupNo: groupNoByPostId.get(d.id) ?? null,
          text: d.body,
          postType:
            d.postType === "thread" ? "thread" : ("standalone" as const),
          publishAtJst: toJstString(publishAtByPostId.get(d.id)!),
          memo: d.memo || undefined,
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        };
      });

      const gasResult = await pushQueue(endpoint, postsForGas);
      if (!gasResult.ok) {
        return NextResponse.json(
          {
            error: "GASへのPush失敗: " + (gasResult.error || "不明"),
            httpStatus: gasResult.httpStatus,
          },
          { status: 502 }
        );
      }
      const queueCheck = await verifyQueueByPostIds(
        endpoint,
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

      // Push成功 → DB更新（executor="gas"）
      let cloudTotalUpdated = 0;
      for (const a of assignments) {
        const r = await prisma.post.updateMany({
          where: { id: { in: a.postIds } },
          data: {
            status: "queued",
            publishAt: a.publishAt,
            executor: "gas",
          },
        });
        cloudTotalUpdated += r.count;
      }
      return NextResponse.json({
        count: cloudTotalUpdated,
        groups: groups.length,
        firstPublishAt: assignments[0]?.publishAt.toISOString(),
        lastPublishAt: assignments[assignments.length - 1]?.publishAt.toISOString(),
        executor: "gas",
        gasRows: gasResult.data?.rows,
      });
    }

    // 通常パス: ローカル node-cron が処理
    let totalUpdated = 0;
    for (const a of assignments) {
      const r = await prisma.post.updateMany({
        where: { id: { in: a.postIds } },
        data: { status: "queued", publishAt: a.publishAt, executor: "local" },
      });
      totalUpdated += r.count;
    }

    return NextResponse.json({
      count: totalUpdated,
      groups: groups.length,
      firstPublishAt: assignments[0]?.publishAt.toISOString(),
      lastPublishAt: assignments[assignments.length - 1]?.publishAt.toISOString(),
      executor: "local",
    });
  } catch (e) {
    console.error("bulk-queue error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
