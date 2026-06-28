/**
 * バックグラウンドスケジューラー
 *
 * 設計方針:
 * - スレッド投稿が途中で失敗しても、成功した■は posted として確定保存
 * - 失敗した■以降は publishAt を15分後に再設定して自動リトライ（最大3回まで）
 * - 3回超えても失敗したら status:"error" で打ち切り
 * - 同じ■を二度Threadsに投げないため、再投稿時は最後の posted の threadsPostId を起点にする
 * - 1時間ガードは「直近のposted投稿から1時間経過」で判定（凍結対策）
 */

import { PrismaClient } from "@prisma/client";
import { publishStandalone, publishThread } from "./threads-api";

const LAYER_TAG_RE = /^\[L[123]\]\s*\n?/;
function stripLayerTag(s: string): string {
  return s.replace(LAYER_TAG_RE, "");
}

const prisma = new PrismaClient();

const MAX_RETRY = 3;
const RETRY_DELAY_MIN = 15;

// 予約時刻の分を過ぎた投稿は「投稿せずにキューに残す」。
// 目的: PCがスリープ/電源オフ/アプリ停止していて長時間止まっていた場合に、
//       復帰直後に「溜まっていた過去の予約」を遅れて投稿してしまう事故を防ぐ。
// （10:00予約は10:00台だけ許可。10:01以降は投稿せず、ユーザーに時刻変更してもらう。）
// クラウドオフロード（executor="gas"）は対象外（GAS側は時間トリガーなのでそもそも遅延しない）。
const PAST_DUE_GRACE_MIN = 1;

let isRunning = false;

/**
 * キューチェック: publishAtが現在時刻以前のqueued投稿を探して投稿する
 *
 * クラウドオフロード対応:
 * - executor:"gas" の投稿はGASトリガーが担当するためここでは拾わない
 * - migrationLock 中はON/OFF切替の最中なので一切実行しない（二重投稿防止）
 */
export async function processQueue() {
  if (isRunning) return;
  isRunning = true;

  try {
    // ON/OFF切替中はスキップ（GAS側でも同じフラグを尊重させる）
    const lock = await prisma.appSetting.findUnique({
      where: { key: "migrationLock" },
    });
    if (lock?.value === "true") {
      console.log("[scheduler] migrationLock active, skipping processQueue");
      return;
    }

    const now = new Date();

    // publishAtが到来しているqueued投稿を取得
    // ※同一グループ内の■順序を必ず保証するため sortOrder を二次キーに
    // ※executor:"local" のみ拾う（"gas" はGASトリガー側で処理）
    const duePosts = await prisma.post.findMany({
      where: {
        status: "queued",
        executor: "local",
        publishAt: { lte: now },
      },
      include: { account: true },
      orderBy: [
        { publishAt: "asc" },
        { groupNo: "asc" },
        { sortOrder: "asc" },
      ],
    });

    // 予約時刻の分を過ぎた投稿は投稿しない（PCスリープ/停止からの復帰時の遅延投稿事故を防ぐ）
    const staleThreshold = new Date(
      now.getTime() - PAST_DUE_GRACE_MIN * 60 * 1000
    );
    const stalePosts = duePosts.filter(
      (p) => p.publishAt !== null && p.publishAt <= staleThreshold
    );
    const freshPosts = duePosts.filter(
      (p) => !(p.publishAt !== null && p.publishAt <= staleThreshold)
    );
    if (stalePosts.length > 0) {
      const staleIds = stalePosts.map((p) => p.id);
      await prisma.post.updateMany({
        where: { id: { in: staleIds } },
        data: {
          error:
            "予約時刻を過ぎたため自動投稿を止めています。必要ならキュー画面の「時刻変更」で新しい日時に変更してください。",
        },
      });
      console.warn(
        `[scheduler] ${stalePosts.length}件の投稿を「予約時刻を過ぎたためスキップ」としてキューに残しました`
      );
    }

    // グループ単位でまとめる（同一account + groupNo）
    const groups = new Map<string, typeof duePosts>();
    for (const post of freshPosts) {
      const key = `${post.accountId}:${post.groupNo}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(post);
    }

    // アカウント別に処理（1時間ルールを守る）
    const accountLastPosted = new Map<string, Date>();

    for (const [, groupPosts] of groups) {
      const account = groupPosts[0].account;

      // 1時間チェック: DB上の直近投稿
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentPost = await prisma.post.findFirst({
        where: {
          accountId: account.id,
          status: "posted",
          postedAt: { gt: oneHourAgo },
        },
        orderBy: { postedAt: "desc" },
      });
      if (recentPost) continue;

      // このバッチ内で既に投稿したアカウントもスキップ
      const lastInBatch = accountLastPosted.get(account.id);
      if (lastInBatch && Date.now() - lastInBatch.getTime() < 60 * 60 * 1000) {
        continue;
      }

      if (!account.accessToken || !account.threadsUserId) {
        const ids = groupPosts.map((p) => p.id);
        await prisma.post.updateMany({
          where: { id: { in: ids } },
          data: { status: "error", error: "アカウントのトークンが未設定です" },
        });
        continue;
      }

      await processGroup(
        account.id,
        account.threadsUserId,
        account.accessToken,
        account.threadsUsername || "",
        groupPosts[0].groupNo,
        groupPosts
      );

      accountLastPosted.set(account.id, new Date());
    }
  } catch (e) {
    console.error("[scheduler] processQueue error:", e);
  } finally {
    isRunning = false;
  }
}

/**
 * 1グループ（=1スレッド or 1単体）の投稿処理
 * 部分成功・自動リトライに対応
 */
async function processGroup(
  accountId: string,
  threadsUserId: string,
  accessToken: string,
  username: string,
  groupNo: number,
  queuedPosts: {
    id: string;
    body: string;
    postType: string;
    retryCount: number;
    sortOrder: number;
  }[]
) {
  // sortOrder順で確実に並べる（部分リトライ時に publishAt が同一になるため、
  // DBのorderBy二次キーだけでは ■2,■3 の順序が依存になりうる）
  const sorted = [...queuedPosts].sort((a, b) => a.sortOrder - b.sortOrder);

  // 本文が空の投稿はゴミ（Threads APIが弾く＝スレッド全体が失敗する元）。
  // 投稿対象から除外し、その行は削除する＝自己修復。空はシステムのどこにも残さない方針。
  const emptyOnes = sorted.filter((p) => p.body.trim() === "");
  if (emptyOnes.length > 0) {
    await prisma.post.deleteMany({
      where: { id: { in: emptyOnes.map((p) => p.id) } },
    });
    console.warn(
      `[scheduler] group ${groupNo}: 本文が空の投稿 ${emptyOnes.length} 件を削除（ゴミ掃除）`
    );
  }
  const queued = sorted.filter((p) => p.body.trim() !== "");
  if (queued.length === 0) {
    console.warn(
      `[scheduler] group ${groupNo}: 本文が空の投稿しかなかったので、まるごと削除しました`
    );
    return;
  }

  const isThread =
    queued.length > 1 || queued[0]?.postType === "thread";

  // 部分成功からの再開: 同groupに既に posted がある場合、その最後のIDから続ける
  let initialReplyTo: string | undefined;
  if (isThread) {
    const postedInGroup = await prisma.post.findMany({
      where: {
        accountId,
        groupNo,
        status: "posted",
        threadsPostId: { not: null },
      },
      orderBy: { sortOrder: "asc" },
    });
    if (postedInGroup.length > 0) {
      const last = postedInGroup[postedInGroup.length - 1];
      initialReplyTo = last.threadsPostId || undefined;
      console.log(
        `[scheduler] resuming group ${groupNo} from postId ${initialReplyTo} (${queued.length} items remaining)`
      );
    }
  }

  const items = queued.map((p) => stripLayerTag(p.body));
  const result =
    isThread || items.length > 1
      ? await publishThread(threadsUserId, accessToken, items, {
          initialReplyTo,
        })
      : await publishStandalone(threadsUserId, accessToken, items[0]);

  // 1) 成功した投稿を確定保存
  if (result.publishedItems && result.publishedItems.length > 0) {
    for (const item of result.publishedItems) {
      const queuedPost = queued[item.index];
      if (!queuedPost) continue;
      await prisma.post.update({
        where: { id: queuedPost.id },
        data: {
          status: "posted",
          threadsPostId: item.threadsPostId,
          postUrl: item.postUrl,
          postedAt: new Date(),
          error: null,
        },
      });
    }
  } else if (result.ok && result.threadsPostId) {
    // 単体投稿の成功パス（publishedItemsを返さない場合）
    await prisma.post.update({
      where: { id: queued[0].id },
      data: {
        status: "posted",
        threadsPostId: result.threadsPostId,
        postUrl: result.postUrl || null,
        postedAt: new Date(),
        error: null,
      },
    });
  }

  // 2) 失敗時: 失敗以降のpostsを再キューに戻す or エラー確定
  if (!result.ok) {
    const failedFrom = result.failedAtIndex ?? 0;
    const remaining = queued.slice(failedFrom);
    if (remaining.length === 0) {
      console.error(
        `[scheduler] group ${groupNo} failed but no remaining posts: ${result.error}`
      );
      return;
    }

    const maxRetry = Math.max(...remaining.map((p) => p.retryCount));

    if (result.permanent || maxRetry >= MAX_RETRY) {
      // 永続エラー or リトライ上限 → エラー確定
      const ids = remaining.map((p) => p.id);
      await prisma.post.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "error",
          error:
            (result.permanent ? "[永続エラー] " : `[${MAX_RETRY}回リトライ失敗] `) +
            (result.error || "Unknown error"),
        },
      });
      console.error(
        `[scheduler] group ${groupNo} gave up: ${result.error} (permanent=${result.permanent}, retry=${maxRetry})`
      );
    } else {
      // 自動リトライ: publishAtを15分後にずらして retryCount++
      const nextPublishAt = new Date(
        Date.now() + RETRY_DELAY_MIN * 60 * 1000
      );
      const ids = remaining.map((p) => p.id);
      await prisma.post.updateMany({
        where: { id: { in: ids } },
        data: {
          publishAt: nextPublishAt,
          retryCount: { increment: 1 },
          error: `[再試行 ${maxRetry + 1}/${MAX_RETRY}] ${result.error}`,
        },
      });
      console.log(
        `[scheduler] group ${groupNo} retry ${maxRetry + 1}/${MAX_RETRY} scheduled at ${nextPublishAt.toISOString()}`
      );
    }
  } else {
    console.log(
      `[scheduler] Posted group ${groupNo} for @${username} (${result.publishedItems?.length ?? 1} item(s))`
    );
  }
}

/**
 * ランダムジッター付きのpublishAtを計算する
 * baseTime ± 5〜15分のランダムずらし
 */
export function addJitter(baseTime: Date): Date {
  const jitterMin = 5;
  const jitterMax = 15;
  const jitterMs =
    (Math.floor(Math.random() * (jitterMax - jitterMin + 1)) + jitterMin) *
    60 *
    1000;
  const direction = Math.random() > 0.5 ? 1 : -1;
  return new Date(baseTime.getTime() + direction * jitterMs);
}
