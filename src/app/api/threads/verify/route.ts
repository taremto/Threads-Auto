import { NextResponse } from "next/server";

/**
 * Threads APIにトークンを投げて接続テスト
 * POST body: { accessToken }
 * 成功: { ok: true, userId, username }
 * 失敗: { ok: false, error }
 */
export async function POST(request: Request) {
  const { accessToken } = await request.json();

  if (!accessToken) {
    return NextResponse.json(
      { ok: false, error: "アクセストークンを入力してください" },
      { status: 400 }
    );
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(
      `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${accessToken}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg =
        body?.error?.message || `HTTP ${res.status}: 接続に失敗しました`;
      return NextResponse.json({ ok: false, error: msg });
    }

    const data = await res.json();
    return NextResponse.json({
      ok: true,
      userId: data.id,
      username: data.username,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: `接続エラー: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
