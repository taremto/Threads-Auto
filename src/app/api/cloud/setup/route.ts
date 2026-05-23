import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import {
  cancelByPostId,
  endpointFromAccount,
  healthCheck,
  pushQueue,
  setConfig,
  toJstString,
  tokenFingerprintOf,
  type PushPostInput,
} from "@/lib/gas-bridge";
import { randomBytes } from "node:crypto";

/** 切替の最中はWeb cron も processQueue も止める（migrationLock） */
async function withMigrationLock<T>(
  fn: () => Promise<T>
): Promise<{ result: T; held: boolean }> {
  // 既存ロックがあるか確認
  const existing = await prisma.appSetting.findUnique({
    where: { key: "migrationLock" },
  });
  if (existing?.value === "true") {
    throw new Error("migrationLock 取得失敗（別の切替処理が進行中）");
  }
  await prisma.appSetting.upsert({
    where: { key: "migrationLock" },
    create: { key: "migrationLock", value: "true" },
    update: { value: "true" },
  });
  try {
    const result = await fn();
    return { result, held: true };
  } finally {
    await prisma.appSetting.upsert({
      where: { key: "migrationLock" },
      create: { key: "migrationLock", value: "false" },
      update: { value: "false" },
    });
  }
}

/**
 * /api/cloud/setup
 *
 * クラウドオフロード設定の各ステップを処理する単一エンドポイント。
 * body.action で分岐:
 *   - "healthCheck": 入力されたURL/Keyに疎通確認（Account保存はしない、検証のみ）
 *   - "initialize":  setConfig をGASに送り、Account に URL/Key/SpreadsheetId を保存
 *                    成功時は cloudOffloadEnabled は触らず、ユーザーが明示ONにする手順
 *   - "enable":      cloudOffloadEnabled=true。既存queuedは現在のGASへ転送して executor="gas" にする
 *   - "disable":     cloudOffloadEnabled=false。transferBack時はGAS側queuedをWeb側へ戻す
 *   - "generateKey": 32-byteのランダムkeyを返却（クライアント側で控えてもらう）
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = body.action as string;

    if (action === "generateKey") {
      // setup-cloud.sh と同じ要領で安全な乱数キー生成
      const key = randomBytes(32).toString("base64url");
      return NextResponse.json({ ok: true, key });
    }

    const accountId = body.accountId as string;
    if (!accountId) {
      return NextResponse.json(
        { error: "accountId required" },
        { status: 400 }
      );
    }
    const account = await prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account) {
      return NextResponse.json(
        { error: "account not found" },
        { status: 404 }
      );
    }

    // healthCheck: 入力されたURL/Keyに疎通確認
    if (action === "healthCheck") {
      const url = body.gasWebAppUrl as string;
      const key = body.gasWebAppKey as string;
      if (!url || !key) {
        return NextResponse.json(
          { error: "gasWebAppUrl と gasWebAppKey が必要です" },
          { status: 400 }
        );
      }
      const r = await healthCheck({ url, key });
      if (!r.ok) {
        return NextResponse.json(
          { ok: false, error: r.error || "GAS疎通失敗", httpStatus: r.httpStatus },
          { status: 502 }
        );
      }
      return NextResponse.json({ ok: true, ...r.data });
    }

    // initialize: setConfig 実行 + Account にURL/Key保存
    if (action === "initialize") {
      const url = body.gasWebAppUrl as string;
      const key = body.gasWebAppKey as string;
      const spreadsheetId = (body.gasSpreadsheetId as string) || null;
      if (!url || !key) {
        return NextResponse.json(
          { error: "gasWebAppUrl と gasWebAppKey が必要です" },
          { status: 400 }
        );
      }
      const token = account.accessToken;
      if (!token) {
        return NextResponse.json(
          {
            error:
              "アカウントの Threads アクセストークンが未設定です。先にアカウント設定でトークンを保存してください",
          },
          { status: 400 }
        );
      }

      const r = await setConfig(
        { url, key },
        { token, webappKey: key, webappUrl: url }
      );
      if (!r.ok) {
        return NextResponse.json(
          { ok: false, error: r.error || "setConfig失敗" },
          { status: 502 }
        );
      }

      // タイムゾーン検証：スクリプトプロジェクトの timeZone が Asia/Tokyo でないと
      // processScheduledPosts が安全のため投稿を停止する（GAS側の防御）。
      // ここで弾いておかないと「設定完了→なのに投稿されない」事故になる。
      const scriptTz = r.data?.scriptTimeZone;
      if (scriptTz !== "Asia/Tokyo") {
        const tzLabel = scriptTz || "未返却";
        return NextResponse.json(
          {
            ok: false,
            error:
              `GASプロジェクトのタイムゾーンが ${tzLabel} になっています（Asia/Tokyo が必要）。` +
              `通常は appsscript.json で自動設定されますが、適用されなかったようです。` +
              `GASコードが古い場合もこのエラーになります。` +
              `Apps Scriptエディタの「プロジェクトの設定（⚙️）→ タイムゾーン」を ` +
              `Asia/Tokyo に変更してから、もう一度クラウドオフロードを設定してください。`,
            scriptTimeZone: scriptTz || null,
          },
          { status: 422 }
        );
      }

      const updated = await prisma.account.update({
        where: { id: accountId },
        data: {
          gasWebAppUrl: url,
          gasWebAppKey: key,
          gasSpreadsheetId: spreadsheetId,
          tokenFingerprint: tokenFingerprintOf(token),
        },
      });
      return NextResponse.json({
        ok: true,
        message: "GAS側の初期化完了。「クラウドオフロードを有効化」で運用開始できます",
        userId: r.data?.user_id,
        username: r.data?.username,
        cloudOffloadEnabled: updated.cloudOffloadEnabled,
        scriptTimeZone: scriptTz,
      });
    }

    // enable: 有効化（migrationLock 経由で既存queuedをGASに転送）
    if (action === "enable") {
      const ep = endpointFromAccount(account);
      if (!ep) {
        return NextResponse.json(
          { error: "GAS Web App URL/Keyが未設定です。先にinitializeを実行してください" },
          { status: 400 }
        );
      }
      // 疎通確認
      const hr = await healthCheck(ep);
      if (!hr.ok || !hr.data?.configured) {
        return NextResponse.json(
          { error: "GAS側の疎通NG: " + (hr.error || "configured=false") },
          { status: 502 }
        );
      }

      try {
        const { result } = await withMigrationLock(async () => {
          // 既存の queued をすべて現在のGASにpushする。
          // 既に executor="gas" のものも含めることで、GASプロジェクトを作り直した場合に
          // 旧シートへ送っていたキューを新シートへ再送できる。
          const queuedPosts = await prisma.post.findMany({
            where: { accountId, status: "queued", publishAt: { not: null } },
            orderBy: [{ publishAt: "asc" }, { sortOrder: "asc" }],
          });
          let transferred = 0;
          if (queuedPosts.length > 0) {
            const postsForGas: PushPostInput[] = queuedPosts.map((p) => ({
              webPostId: p.id,
              groupNo: p.groupNo,
              text: p.body,
              postType:
                p.postType === "thread" ? "thread" : ("standalone" as const),
              publishAtJst: toJstString(p.publishAt!),
              memo: p.memo || undefined,
            }));
            const pr = await pushQueue(ep, postsForGas);
            if (!pr.ok) {
              throw new Error(
                "既存queuedのGAS転送失敗: " + (pr.error || "不明")
              );
            }
            await prisma.post.updateMany({
              where: { id: { in: queuedPosts.map((p) => p.id) } },
              data: { executor: "gas" },
            });
            transferred = queuedPosts.length;
          }
          await prisma.account.update({
            where: { id: accountId },
            data: { cloudOffloadEnabled: true },
          });
          return { transferred };
        });
        return NextResponse.json({
          ok: true,
          message:
            "クラウドオフロードを有効化しました" +
            (result.transferred > 0
              ? `。既存の ${result.transferred} 件のqueuedをGASに転送済`
              : ""),
          transferred: result.transferred,
        });
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 500 }
        );
      }
    }

    // disable: 無効化（GAS側queuedをローカルに引き戻して安全に切替）
    if (action === "disable") {
      const ep = endpointFromAccount(account);
      const queuedGasCount = await prisma.post.count({
        where: { accountId, status: "queued", executor: "gas" },
      });

      // GAS側にqueued無し → 単純無効化
      if (queuedGasCount === 0) {
        await prisma.account.update({
          where: { id: accountId },
          data: { cloudOffloadEnabled: false },
        });
        return NextResponse.json({
          ok: true,
          message: "クラウドオフロードを無効化しました",
          transferredBack: 0,
        });
      }

      // queued あり → transferBack か force のどちらかが必要
      if (!body.transferBack && !body.force) {
        return NextResponse.json(
          {
            error: `GAS側に ${queuedGasCount} 件のqueued投稿が残っています。transferBack=true で Web側に引き戻し、force=true で強制無効化（GAS側はそのまま動作）`,
            queuedGasCount,
          },
          { status: 409 }
        );
      }

      try {
        const { result } = await withMigrationLock(async () => {
          let transferredBack = 0;
          if (body.transferBack && ep) {
            // GAS側のqueued分をキャンセル → executor="local" に書き戻し
            const gasPosts = await prisma.post.findMany({
              where: { accountId, status: "queued", executor: "gas" },
            });
            for (const gp of gasPosts) {
              const cr = await cancelByPostId(ep, gp.id);
              if (!cr.ok) {
                console.warn(
                  `[/api/cloud/setup disable] cancel失敗 (postId=${gp.id}): ${cr.error}`
                );
              }
            }
            await prisma.post.updateMany({
              where: { accountId, status: "queued", executor: "gas" },
              data: { executor: "local" },
            });
            transferredBack = gasPosts.length;
          }
          await prisma.account.update({
            where: { id: accountId },
            data: { cloudOffloadEnabled: false },
          });
          return { transferredBack };
        });

        return NextResponse.json({
          ok: true,
          message:
            "クラウドオフロードを無効化しました" +
            (result.transferredBack > 0
              ? `（${result.transferredBack} 件をWeb側に引き戻し）`
              : "（強制無効化）"),
          transferredBack: result.transferredBack,
        });
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(
      { error: `unknown action: ${action}` },
      { status: 400 }
    );
  } catch (e) {
    console.error("[/api/cloud/setup] error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
