import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 外出先からアクセスできるようにする（リモートアクセス）ための認証ゲート。
//
// 環境変数 REMOTE_PASSWORD が設定されているときだけ有効になる。
// 設定されていなければ素通り（= 今までどおりローカルで使うときは何も変わらない）。
//
// 有効時は Basic 認証で全リクエストを保護する。トンネル（cloudflared 等）で
// インターネットに公開しても、パスワードを知っている人しかアプリを開けない。
//   - ユーザー名: 何でもよい（例: user）
//   - パスワード: REMOTE_PASSWORD と同じ文字列
export function proxy(request: NextRequest) {
  const expected = process.env.REMOTE_PASSWORD;

  // パスワード未設定 → ゲート無効。ローカル利用はこれまでと完全に同じ。
  if (!expected) return NextResponse.next();

  const header = request.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    let decoded = "";
    try {
      decoded = atob(encoded);
    } catch {
      decoded = "";
    }
    // "user:password" のうち、最初の ":" 以降をパスワードとして取り出す
    const sep = decoded.indexOf(":");
    const pass = sep >= 0 ? decoded.slice(sep + 1) : "";
    if (pass.length === expected.length && pass === expected) {
      return NextResponse.next();
    }
  }

  return new NextResponse("認証が必要です。", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Threads Auto", charset="UTF-8"',
    },
  });
}

// _next（HMR・静的アセット）と favicon 以外の全パスを保護する。
// /api も含めて保護されるので、トークン等が外部に漏れない。
export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"],
};
