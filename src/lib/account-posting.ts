export const DEFAULT_ACCOUNT_POSTING_HOURS = [6, 12, 18, 21];
export const MAX_GENERATE_POSTS = 30;

export function normalizeAccountPostingHours(value: unknown): number[] {
  let raw = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw)) return DEFAULT_ACCOUNT_POSTING_HOURS;
  const hours = [...new Set(raw.map((h) => Number(h)))]
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);
  return hours.length > 0 ? hours : DEFAULT_ACCOUNT_POSTING_HOURS;
}

export function dailyPostCountFromPostingHours(value: unknown): number {
  return normalizeAccountPostingHours(value).length;
}

export function buildGenerationCountOptions(
  dailyCount: number,
  limit = MAX_GENERATE_POSTS
): number[] {
  const safeLimit = Math.max(1, Math.min(MAX_GENERATE_POSTS, Math.floor(limit)));
  const safeDaily = Math.max(1, Math.min(24, Math.floor(dailyCount || 1)));
  const options = Array.from({ length: safeLimit }, (_, i) => i + 1);
  if (safeDaily > safeLimit) return options;
  return [safeDaily, ...options.filter((n) => n !== safeDaily)];
}

export function generationCountLabel(count: number, dailyCount: number): string {
  const safeDaily = Math.max(1, Math.floor(dailyCount || 1));
  if (count === safeDaily) {
    return `${count}投稿（1日分・このアカウントの設定本数）`;
  }
  if (count > safeDaily && count % safeDaily === 0) {
    return `${count}投稿（${count / safeDaily}日分）`;
  }
  return `${count}投稿`;
}
