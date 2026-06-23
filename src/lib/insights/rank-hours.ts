/**
 * rank-hours.ts — 時間別パフォーマンス(hourly)から、設定した投稿枠のうち
 * 実績の良い枠を割り出す純関数。DB非依存なので単体テストしやすい。
 */
export type HourPerf = { hour: number; avgEr: number; avgViews: number; count: number };

export type PreferredHours = {
  hours: number[]; // 実績の良い順（postingHours の部分集合）
  stats: Record<number, { avgEr: number; avgViews: number; count: number }>;
};

export type RankOptions = {
  window?: number; // ±何時間を1枠にまとめるか（実投稿はちょうどの時刻に載らないため）
  minSamples?: number; // 窓内の最小サンプル数（これ未満の枠は採用しない）
  topK?: number; // 推奨ターゲットに残す上位件数
};

/**
 * aggregate() の hourly（24要素）と投稿枠から、実績順に並べた推奨枠を返す。
 * データ不足（採用枠0）なら null。
 */
export function rankPostingHoursByPerformance(
  hourly: HourPerf[],
  postingHours: number[],
  opts: RankOptions = {}
): PreferredHours | null {
  const window = opts.window ?? 1;
  const minSamples = opts.minSamples ?? 3;
  const topK = opts.topK ?? 2;

  const byHour = new Map<number, HourPerf>();
  for (const h of hourly) byHour.set(h.hour, h);

  const scored: HourPerf[] = [];
  for (const H of postingHours) {
    let count = 0;
    let viewsWeighted = 0;
    let erWeighted = 0;
    for (let d = -window; d <= window; d++) {
      const hh = (((H + d) % 24) + 24) % 24;
      const b = byHour.get(hh);
      if (!b || b.count <= 0) continue;
      count += b.count;
      viewsWeighted += b.avgViews * b.count;
      erWeighted += b.avgEr * b.count;
    }
    if (count < minSamples) continue;
    scored.push({
      hour: H,
      avgEr: count > 0 ? Math.round((erWeighted / count) * 100) / 100 : 0,
      avgViews: count > 0 ? Math.round(viewsWeighted / count) : 0,
      count,
    });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.avgEr - a.avgEr || b.avgViews - a.avgViews);

  const hours = scored.slice(0, Math.max(1, topK)).map((s) => s.hour);
  const stats: PreferredHours["stats"] = {};
  for (const s of scored) {
    stats[s.hour] = { avgEr: s.avgEr, avgViews: s.avgViews, count: s.count };
  }
  return { hours, stats };
}
