import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { aggregate, type AnalyticsItem } from "@/lib/insights/aggregate";

/**
 * 分析「表示回数TOP15」を、ユーザー自身のGoogleスプレッドシートへ書き込む。
 *
 * 経路: webアプリ → ユーザーのスプシにバインドしたGAS Web App(doPost) → シート書き込み。
 * 投稿用のクラウドオフロード(appscript.gs / Account.gasWebAppUrl)とは独立した別連携で、
 * 接続先URLは AppSetting("analyticsExportUrl:<accountId>") に保存する（schema変更不要）。
 *
 * GET  ?accountId=...                 → { url, configured }
 * POST { accountId, mode:"save", url }→ pingして疎通OKなら保存 → { ok, url }
 * POST { accountId }（mode省略=send） → 上位15件を組み立ててGASへ送信 → { ok, written }
 */

// gas/analytics-export.gs の EXPORT_KEY と一致させる固定キー
const EXPORT_KEY = "nuko-sheet-export-v1";

const settingKey = (accountId: string) => `analyticsExportUrl:${accountId}`;

async function callGas(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<{ ok: boolean; message?: string; data?: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, key: EXPORT_KEY }),
      signal: ctrl.signal,
      redirect: "follow", // GAS Web App は 302 を返すので follow 必須
    });
    const text = await resp.text();
    let parsed: { status?: string; message?: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      const looksLikeHtml = /<!doctype html|<html[\s>]/i.test(text);
      return {
        ok: false,
        message: looksLikeHtml
          ? "GoogleからログインページのHTMLが返りました。デプロイの『アクセスできるユーザー』が『全員』になっているか確認してください。"
          : `Google側の応答を読み取れませんでした (HTTP ${resp.status})。`,
      };
    }
    if (parsed.status === "ok") return { ok: true, data: parsed };
    return { ok: false, message: parsed.message || `GASエラー (status=${parsed.status})` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: /abort/i.test(msg)
        ? "Google側の応答がありませんでした（タイムアウト）。URLが正しいか確認してください。"
        : `送信に失敗しました: ${msg}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isValidGasUrl(url: string): boolean {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/.test(url.trim());
}

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }
  const row = await prisma.appSetting.findUnique({
    where: { key: settingKey(accountId) },
  });
  return NextResponse.json({ url: row?.value ?? null, configured: !!row?.value });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      accountId?: string;
      mode?: "save" | "send";
      url?: string;
    };
    const accountId = body.accountId;
    if (!accountId) {
      return NextResponse.json({ error: "accountId is required" }, { status: 400 });
    }

    // --- モード: URL保存（疎通確認つき） ---
    if (body.mode === "save") {
      const url = (body.url || "").trim();
      if (!isValidGasUrl(url)) {
        return NextResponse.json(
          {
            error:
              "URLの形式が違うようです。Apps Scriptのデプロイで表示された『https://script.google.com/macros/s/●●●/exec』で終わるURLを貼り付けてください。",
          },
          { status: 400 }
        );
      }
      const ping = await callGas(url, { action: "ping" }, 20_000);
      if (!ping.ok) {
        return NextResponse.json(
          { error: `接続テストに失敗しました。${ping.message ?? ""}` },
          { status: 502 }
        );
      }
      await prisma.appSetting.upsert({
        where: { key: settingKey(accountId) },
        create: { key: settingKey(accountId), value: url },
        update: { value: url },
      });
      return NextResponse.json({ ok: true, url });
    }

    // --- モード: 送信（上位15件を書き込む） ---
    const setting = await prisma.appSetting.findUnique({
      where: { key: settingKey(accountId) },
    });
    if (!setting?.value) {
      return NextResponse.json(
        { error: "先にスプレッドシート連携の設定（URLの保存）が必要です。" },
        { status: 400 }
      );
    }

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, name: true },
    });
    if (!account) {
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    }

    // insights/route.ts と同じ要領で Post + HistoricalPost をマージして集計
    const [posts, historical] = await Promise.all([
      prisma.post.findMany({
        where: { accountId },
        select: {
          id: true,
          groupNo: true,
          threadsPostId: true,
          status: true,
          postedAt: true,
          body: true,
          postUrl: true,
          lastViews: true,
          lastLikes: true,
          lastReplies: true,
          lastReposts: true,
          lastQuotes: true,
          lastEr: true,
        },
      }),
      prisma.historicalPost.findMany({
        where: { accountId },
        select: {
          id: true,
          threadsPostId: true,
          postedAt: true,
          text: true,
          treeBody: true,
          postUrl: true,
          views: true,
          likes: true,
          replies: true,
          reposts: true,
          quotes: true,
          er: true,
        },
      }),
    ]);

    const internalThreadsIds = new Set(
      posts.map((p) => p.threadsPostId).filter((x): x is string => !!x)
    );

    const items: AnalyticsItem[] = [];
    for (const p of posts) {
      items.push({
        key: p.id,
        threadsPostId: p.threadsPostId,
        source: "post",
        status: p.status,
        postedAt: p.postedAt,
        text: p.body,
        postUrl: p.postUrl,
        views: p.lastViews,
        likes: p.lastLikes,
        replies: p.lastReplies,
        reposts: p.lastReposts,
        quotes: p.lastQuotes,
        er: p.lastEr,
      });
    }
    for (const h of historical) {
      if (h.threadsPostId && internalThreadsIds.has(h.threadsPostId)) continue;
      items.push({
        key: h.id,
        threadsPostId: h.threadsPostId,
        source: "historical",
        status: "posted",
        postedAt: h.postedAt,
        text: h.text,
        postUrl: h.postUrl,
        views: h.views,
        likes: h.likes,
        replies: h.replies,
        reposts: h.reposts,
        quotes: h.quotes,
        er: h.er,
      });
    }

    const result = aggregate(items);
    const top = result.topPosts.slice(0, 15);
    if (top.length === 0) {
      return NextResponse.json(
        { error: "表示回数のある投稿がまだありません。先に「最新を取得」してください。" },
        { status: 422 }
      );
    }

    // ツリー全文の解決用に、Post の groupNo→本文、Historical の treeBody を引けるようにする
    const groupBodies = new Map<number, string[]>();
    for (const p of [...posts].sort((a, b) => a.id.localeCompare(b.id))) {
      if (p.groupNo == null) continue;
      const arr = groupBodies.get(p.groupNo) ?? [];
      arr.push(p.body);
      groupBodies.set(p.groupNo, arr);
    }
    const postGroupOf = new Map(posts.map((p) => [p.id, p.groupNo] as const));
    const historicalById = new Map(historical.map((h) => [h.id, h] as const));

    const fullText = (p: (typeof top)[number]): string => {
      if (p.source === "post") {
        const g = postGroupOf.get(p.key);
        if (g != null) {
          const bodies = groupBodies.get(g);
          if (bodies && bodies.length > 0) return bodies.join("\n\n");
        }
        return p.text;
      }
      const h = historicalById.get(p.key);
      if (h?.treeBody && h.treeBody.trim()) return h.treeBody;
      return p.text;
    };

    const header = [
      "順位",
      "投稿日",
      "投稿文（ツリー全文）",
      "表示回数",
      "いいね数",
      "返信数",
      "ER(%)",
      "投稿URL",
    ];
    const rows: (string | number)[][] = [header];
    top.forEach((p, i) => {
      rows.push([
        i + 1,
        p.postedAt ? new Date(p.postedAt).toLocaleDateString("ja-JP") : "",
        fullText(p),
        p.views,
        p.likes,
        p.replies,
        p.er,
        p.postUrl || "",
      ]);
    });

    const send = await callGas(setting.value, { action: "writeAnalytics", rows });
    if (!send.ok) {
      return NextResponse.json(
        { error: `スプレッドシートへの書き込みに失敗しました。${send.message ?? ""}` },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      written: top.length,
      sheet: (send.data?.sheet as string) ?? "表示回数TOP15",
    });
  } catch (e) {
    return NextResponse.json(
      { error: String((e as Error)?.message || e) },
      { status: 500 }
    );
  }
}
