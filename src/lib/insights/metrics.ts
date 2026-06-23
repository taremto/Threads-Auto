/**
 * 分析の純粋計算ロジック（GAS v9.1 から移植）
 * - テスト可能な副作用なし関数群
 */

/**
 * エンゲージメント率（%）= (likes+replies+reposts+quotes) / views * 100
 * views<=0 のときは算出不能として null を返す（GAS では空文字）
 */
export function calcEr(
  views: number | null | undefined,
  likes: number | null | undefined,
  replies: number | null | undefined,
  reposts: number | null | undefined,
  quotes: number | null | undefined
): number | null {
  const v = Number(views) || 0;
  if (v <= 0) return null;
  const e =
    (Number(likes) || 0) +
    (Number(replies) || 0) +
    (Number(reposts) || 0) +
    (Number(quotes) || 0);
  return Math.round((e / v) * 10000) / 100;
}

export type TimeBand = "朝" | "昼" | "夜" | "深夜";

/**
 * 時間帯ラベル（JSTの時で判定）
 * 朝5-10 / 昼11-16 / 夜17-22 / 深夜(それ以外)
 */
export function timeBandFromHour(hour: number): TimeBand {
  if (hour >= 5 && hour <= 10) return "朝";
  if (hour >= 11 && hour <= 16) return "昼";
  if (hour >= 17 && hour <= 22) return "夜";
  return "深夜";
}

/** Date を Asia/Tokyo の時（0-23）に変換 */
export function jstHour(date: Date): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    hour12: false,
  }).format(date);
  // "24" が返るケース（深夜0時）を 0 に正規化
  const h = parseInt(s, 10);
  return Number.isFinite(h) ? h % 24 : 0;
}

/** Date を Asia/Tokyo の "YYYY-MM-DD" に変換 */
export function jstDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  // en-CA は "YYYY-MM-DD"
  return parts;
}

export function timeBandFromDate(date: Date): TimeBand {
  return timeBandFromHour(jstHour(date));
}

/**
 * 80パーセンタイル（GAS calcPercentile(arr, 0.8) と同一アルゴリズム）
 * 昇順ソート → index = ceil(0.8*len)-1（クランプ）
 * 空配列は 0
 */
export function percentile(values: number[], p = 0.8): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let index = Math.ceil(p * sorted.length) - 1;
  if (index < 0) index = 0;
  if (index >= sorted.length) index = sorted.length - 1;
  return sorted[index];
}
