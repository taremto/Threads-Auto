import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  endpointFromAccount,
  healthCheck,
  isGasMediaCleanupSupported,
  pruneMedia,
} from "@/lib/gas-bridge";

/**
 * /api/cloud/prune-media  (POST { accountId })
 *
 * そのアカウントのメディアフォルダ(ThreadsAutoMedia)内で、
 * 現存する投稿(PostMedia)に紐づかない「孤立画像」だけをゴミ箱へ移動する。
 * ＝既存の溜まり分を一度だけ整理する手動操作。投稿に使っている画像は残る。
 */
export async function POST(request: Request) {
  try {
    const { accountId } = (await request.json()) as { accountId?: string };
    if (!accountId) {
      return NextResponse.json({ error: "accountId required" }, { status: 400 });
    }

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) {
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    }
    const endpoint = account.cloudOffloadEnabled
      ? endpointFromAccount(account)
      : null;
    if (!endpoint) {
      return NextResponse.json(
        { error: "このアカウントはクラウドオフロードが未設定です。" },
        { status: 422 }
      );
    }

    // GAS が画像整理に対応した版か確認（v1.1.12以降）。未対応なら修復を促す。
    const health = await healthCheck(endpoint);
    if (!health.ok || !health.data) {
      return NextResponse.json(
        { error: "Google側に接続できませんでした。ネット接続を確認してください。" },
        { status: 502 }
      );
    }
    if (!isGasMediaCleanupSupported(health.data.version)) {
      return NextResponse.json(
        {
          error:
            "Google側の更新が必要です。設定のクラウドオフロード欄から「Google投稿を修復する」を一度実行してください。",
          needsRepair: true,
        },
        { status: 422 }
      );
    }

    // 現存する投稿に紐づく driveFileId を keep集合として渡す
    const media = await prisma.postMedia.findMany({
      where: { post: { accountId }, driveFileId: { not: null } },
      select: { driveFileId: true },
    });
    const keepIds = media
      .map((m) => m.driveFileId)
      .filter((x): x is string => !!x);

    const r = await pruneMedia(endpoint, keepIds);
    if (!r.ok || !r.data) {
      return NextResponse.json(
        { error: r.error || "画像の整理に失敗しました。" },
        { status: 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      trashed: r.data.trashed,
      kept: r.data.kept,
    });
  } catch (e) {
    console.error("[/api/cloud/prune-media] error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
