import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  endpointFromAccount,
  healthCheck,
  isGasVersionSupported,
  gasVersionUpgradeMessage,
  uploadMedia,
  deleteMedia,
  pushQueue,
  toJstString,
  type GasEndpoint,
  type PushPostInput,
} from "@/lib/gas-bridge";

// キュー(executor=gas)投稿に画像を付け外ししたら、GASスプシ行のメディア列も更新する。
// pushQueue は既存行をメディア込みで upsert する（GAS v1.1.11）。投稿済みはGAS側でガード。
async function syncQueuedMediaToGas(
  post: {
    id: string;
    groupNo: number;
    body: string;
    postType: string;
    publishAt: Date | null;
    memo: string | null;
    status: string;
    executor: string;
  },
  endpoint: GasEndpoint
): Promise<{ ok: boolean; error?: string }> {
  if (post.status !== "queued" || post.executor !== "gas") return { ok: true };
  if (!post.publishAt) return { ok: false, error: "予約日時がありません" };
  const media = await prisma.postMedia.findMany({
    where: { postId: post.id, status: "ready" },
    orderBy: { sortOrder: "asc" },
  });
  const imageUrls = media.map((m) => m.publicUrl).filter(Boolean);
  const input: PushPostInput = {
    webPostId: post.id,
    groupNo: post.groupNo,
    text: post.body,
    postType: post.postType === "thread" ? "thread" : "standalone",
    publishAtJst: toJstString(post.publishAt),
    memo: post.memo || undefined,
    imageUrls,
  };
  const r = await pushQueue(endpoint, [input]);
  return r.ok ? { ok: true } : { ok: false, error: r.error || "GAS同期に失敗" };
}

const GAS_SYNC_FAIL_MSG =
  "画像は保存しましたが、Google（予約）側へ反映できませんでした。もう一度試すか、一度キューから外して入れ直すと確実です。";

// 投稿への画像添付（クラウドオフロード済みアカウントのみ。GAS経由でDriveにアップ→公開URL化）
// GET    /api/posts/media?postId=...      → その投稿の添付一覧
// POST   /api/posts/media                  body: { postId, images: [{ base64, mimeType, fileName }] }
// DELETE /api/posts/media?mediaId=...      → 添付を削除

export async function GET(request: NextRequest) {
  const postId = request.nextUrl.searchParams.get("postId");
  if (!postId) {
    return NextResponse.json({ error: "postId is required" }, { status: 400 });
  }
  const media = await prisma.postMedia.findMany({
    where: { postId },
    orderBy: { sortOrder: "asc" },
  });
  return NextResponse.json(media);
}

type IncomingImage = { base64?: string; mimeType?: string; fileName?: string };

export async function POST(request: Request) {
  try {
    const { postId, images } = (await request.json()) as {
      postId?: string;
      images?: IncomingImage[];
    };
    if (!postId) {
      return NextResponse.json({ error: "postId is required" }, { status: 400 });
    }
    if (!Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: "images is required" }, { status: 400 });
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { account: true },
    });
    if (!post) {
      return NextResponse.json({ error: "post not found" }, { status: 404 });
    }
    const account = post.account;

    // ガード: 画像添付はクラウドオフロード（Google連携）済みのみ
    const endpoint = account.cloudOffloadEnabled ? endpointFromAccount(account) : null;
    if (!endpoint) {
      return NextResponse.json(
        {
          error:
            "画像添付にはクラウドオフロード（Google連携）の設定が必要です。設定 → アカウント編集 → ☁ クラウドオフロード から設定してください。",
          needsCloudOffload: true,
        },
        { status: 422 }
      );
    }

    // GAS が画像アップロード対応版か確認（未対応なら修復＝再デプロイ＋Drive権限の再承認）
    const health = await healthCheck(endpoint);
    if (!health.ok || !health.data) {
      return NextResponse.json(
        {
          error:
            "Google側に接続できないため、画像をアップロードできませんでした。ネット接続とクラウドオフロード設定を確認してください。",
          detail: health.error,
        },
        { status: 502 }
      );
    }
    if (!isGasVersionSupported(health.data.version)) {
      return NextResponse.json(
        { error: gasVersionUpgradeMessage(health.data.version), needsRepair: true },
        { status: 422 }
      );
    }

    // 既存の添付の末尾に追加
    const existingMax = await prisma.postMedia.aggregate({
      where: { postId },
      _max: { sortOrder: true },
    });
    let nextSort = (existingMax._max.sortOrder ?? -1) + 1;

    const created: { id: string; publicUrl: string; sortOrder: number; status: string }[] = [];
    const errors: string[] = [];

    for (const img of images) {
      if (!img.base64 || !img.mimeType) {
        errors.push("画像データが不正です");
        continue;
      }
      const media = await prisma.postMedia.create({
        data: {
          postId,
          mediaType: "image",
          sortOrder: nextSort++,
          publicUrl: "",
          status: "uploading",
        },
      });
      const _t0 = Date.now();
      const up = await uploadMedia(endpoint, {
        base64: img.base64,
        mimeType: img.mimeType,
        fileName: img.fileName || `image_${media.id}`,
        webPostId: postId,
      });
      console.log(
        `[media] upload ${Math.round((img.base64.length * 0.75) / 1024)}KB in ${Date.now() - _t0}ms (${up.ok ? "ok" : "fail"})`
      );
      if (up.ok && up.data?.publicUrl) {
        const updated = await prisma.postMedia.update({
          where: { id: media.id },
          data: {
            publicUrl: up.data.publicUrl,
            driveFileId: up.data.driveFileId,
            status: "ready",
          },
        });
        created.push({
          id: updated.id,
          publicUrl: updated.publicUrl,
          sortOrder: updated.sortOrder,
          status: updated.status,
        });
      } else {
        await prisma.postMedia.update({
          where: { id: media.id },
          data: { status: "error" },
        });
        errors.push(up.error || "アップロードに失敗しました");
      }
    }

    const media = await prisma.postMedia.findMany({
      where: { postId },
      orderBy: { sortOrder: "asc" },
    });

    // キュー済み(GAS)投稿なら、GASスプシ行のメディア列も更新する
    let gasSyncWarning: string | undefined;
    if (created.length > 0 && post.status === "queued" && post.executor === "gas") {
      const sync = await syncQueuedMediaToGas(post, endpoint);
      if (!sync.ok) gasSyncWarning = GAS_SYNC_FAIL_MSG;
    }

    return NextResponse.json({
      ok: created.length > 0,
      added: created.length,
      errors,
      media,
      gasSyncWarning,
    });
  } catch (e) {
    return NextResponse.json(
      { error: String((e as Error)?.message || e) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const mediaId = request.nextUrl.searchParams.get("mediaId");
  if (!mediaId) {
    return NextResponse.json({ error: "mediaId is required" }, { status: 400 });
  }
  const target = await prisma.postMedia.findUnique({
    where: { id: mediaId },
    include: { post: { include: { account: true } } },
  });
  await prisma.postMedia.delete({ where: { id: mediaId } }).catch(() => {});

  const post = target?.post;
  const endpoint =
    post && post.account.cloudOffloadEnabled
      ? endpointFromAccount(post.account)
      : null;

  // 外した画像はDriveからもゴミ箱へ（ベストエフォート。旧GAS/失敗時は無視）
  if (endpoint && target?.driveFileId) {
    await deleteMedia(endpoint, [target.driveFileId]).catch(() => {});
  }

  // キュー済み(GAS)投稿なら、残りのメディアでGAS行を再同期（全部消したらメディア列もクリア）
  let gasSyncWarning: string | undefined;
  if (post && endpoint && post.status === "queued" && post.executor === "gas") {
    const sync = await syncQueuedMediaToGas(post, endpoint);
    if (!sync.ok) gasSyncWarning = GAS_SYNC_FAIL_MSG;
  }
  return NextResponse.json({ ok: true, gasSyncWarning });
}
