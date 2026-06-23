const THREADS_API_BASE = "https://graph.threads.net/v1.0";

export type ThreadsIdentity = {
  userId: string;
  username: string | null;
};

export type ThreadsIdentityResult =
  | { ok: true; identity: ThreadsIdentity }
  | { ok: false; error: string };

type FetchLike = typeof fetch;

function maskTokenLikeText(text: string) {
  return String(text).replace(/[A-Za-z0-9_-]{20,}/g, "***");
}

function normalizeIdentityPayload(raw: string) {
  const safeRaw = raw.replace(/"id"\s*:\s*(\d{16,})/g, '"id":"$1"');
  return JSON.parse(safeRaw) as {
    id?: string | number;
    username?: string | null;
    error?: { message?: string; type?: string; code?: string | number };
  };
}

export async function fetchThreadsIdentity(
  accessToken: string,
  opts: { fetcher?: FetchLike; timeoutMs?: number } = {}
): Promise<ThreadsIdentityResult> {
  const token = accessToken.trim();
  if (token.length < 10) {
    return { ok: false, error: "Threadsアクセストークンが短すぎます。" };
  }

  const fetcher = opts.fetcher || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const url =
      `${THREADS_API_BASE}/me?fields=id,username&access_token=` +
      encodeURIComponent(token);
    const res = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: ReturnType<typeof normalizeIdentityPayload>;
    try {
      data = normalizeIdentityPayload(text);
    } catch {
      return {
        ok: false,
        error: `Threadsの本人確認レスポンスを読み取れませんでした (HTTP ${res.status})。`,
      };
    }
    if (!res.ok || data.error) {
      const message = data.error?.message || `HTTP ${res.status}`;
      return {
        ok: false,
        error: maskTokenLikeText(`Threadsの本人確認に失敗しました: ${message}`),
      };
    }
    if (!data.id) {
      return {
        ok: false,
        error: "Threadsの本人確認でユーザーIDを取得できませんでした。",
      };
    }
    return {
      ok: true,
      identity: {
        userId: String(data.id),
        username: data.username ? String(data.username) : null,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error:
        "Threadsの本人確認に失敗しました: " +
        (e instanceof Error ? e.message : String(e)),
    };
  } finally {
    clearTimeout(timer);
  }
}
