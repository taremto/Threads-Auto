/**
 * Threads API の永続エラー判定（共有util）
 * - 権限・トークン・無効リクエスト系はリトライしても回復しない
 * - 投稿(threads-api.ts)とInsights取得(lib/insights)の両方で使う
 */
export function isPermanentError(msg: string | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return /permission|expired|unauthorized|invalid(?:[_\s-]+oauth)?[_\s-]*(?:token|access|request|user|parameter)|oauth[_\s-]+access[_\s-]+token|cannot[_\s-]+parse[_\s-]+access[_\s-]+token|deactivated|forbidden|not authorized|access[_\s-]*denied/.test(
    lower
  );
}

/**
 * Insights/権限スコープ不足を示すエラーか（縮退判定用）
 * Threads Insights は threads_manage_insights 権限が必要で、
 * 権限の無いトークンは permission/(#10)/insights 系のエラーを返す
 */
export function isInsightsPermissionError(msg: string | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    isPermanentError(msg) ||
    /insight|metric|\(#10\)|\(#100\)|does not have permission|requires .*permission/.test(
      lower
    )
  );
}
