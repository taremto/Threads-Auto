// 小さな fetch ラッパー。
// - レスポンスが JSON でない（= サーバーが HTML エラーページを返した等）場合でも
//   「Unexpected token <」のような分かりにくいエラーにせず、素直な日本語メッセージにする。
// - サーバーが { error: "..." } を返していればそれをそのまま使う。

type JsonInit = Omit<RequestInit, "body" | "method"> & {
  method?: string;
  body?: unknown;
};

async function request<T>(url: string, init: JsonInit): Promise<T> {
  const { body, method, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers:
      body !== undefined
        ? { "Content-Type": "application/json", ...(headers ?? {}) }
        : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // 非JSON（HTMLエラーページ等）。data は null のまま。
    }
  }

  if (!res.ok) {
    const fromBody =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : null;
    throw new Error(
      fromBody ||
        `サーバーでエラーが発生しました (${res.status})。少し時間をおいて、もう一度お試しください。`
    );
  }

  return (data ?? {}) as T;
}

export function getJSON<T = unknown>(url: string, init?: JsonInit): Promise<T> {
  return request<T>(url, { ...(init ?? {}), method: "GET" });
}

export function postJSON<T = unknown>(
  url: string,
  body?: unknown,
  init?: JsonInit
): Promise<T> {
  return request<T>(url, { ...(init ?? {}), method: "POST", body });
}

export function patchJSON<T = unknown>(
  url: string,
  body?: unknown,
  init?: JsonInit
): Promise<T> {
  return request<T>(url, { ...(init ?? {}), method: "PATCH", body });
}
