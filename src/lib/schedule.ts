const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MIN_POST_INTERVAL_MINUTES = 60;

function jstParts(d: Date): { year: number; month: number; day: number } {
  const jst = new Date(d.getTime() + JST_OFFSET_MS);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth(),
    day: jst.getUTCDate(),
  };
}

function utcDateFromJst(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
): Date {
  return new Date(Date.UTC(year, month, day, hour - 9, minute, 0, 0));
}

/**
 * 投稿スロットを日本時間固定で生成する。
 * ユーザーPCのタイムゾーンが日本以外でも、postingHours は必ずJSTの時刻として扱う。
 */
export function buildJstSlots(
  now: Date,
  postingHours: number[],
  needed: number,
  opts: { minLeadMinutes?: number; minGapMinutes?: number; maxDays?: number } = {}
): Date[] {
  const minLeadMinutes = opts.minLeadMinutes ?? 30;
  const minGapMinutes = opts.minGapMinutes ?? 65;
  const maxDays = opts.maxDays ?? 60;
  const minStart = new Date(now.getTime() + minLeadMinutes * 60 * 1000);
  const base = jstParts(now);
  const cleanHours = [...new Set(postingHours)]
    .map((h) => Number(h))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);
  const hours = cleanHours.length > 0 ? cleanHours : [6, 12, 18, 21];
  const slots: Date[] = [];

  for (let dayOffset = 0; dayOffset <= maxDays && slots.length < needed; dayOffset++) {
    for (const h of hours) {
      const slot = utcDateFromJst(base.year, base.month, base.day + dayOffset, h);
      if (slot < minStart) continue;
      const prev = slots[slots.length - 1];
      if (!prev || slot.getTime() - prev.getTime() >= minGapMinutes * 60 * 1000) {
        slots.push(slot);
        if (slots.length >= needed) break;
      }
    }
  }

  return slots;
}

export function applyMinuteJitter(
  slots: Date[],
  jitterMinutes: number,
  random: () => number = Math.random
): Date[] {
  const max = Math.max(0, Math.min(59, Math.floor(Number(jitterMinutes) || 0)));
  if (max === 0) return slots;
  return slots.map((slot) => {
    const raw = Math.floor(random() * (max + 1));
    const offset = Math.min(max, raw);
    return new Date(slot.getTime() + offset * 60 * 1000);
  });
}

export function hasPostIntervalConflict(
  candidate: Date,
  busyTimes: Date[],
  minGapMinutes = MIN_POST_INTERVAL_MINUTES
): boolean {
  const minGapMs = minGapMinutes * 60 * 1000;
  const candidateMs = candidate.getTime();
  return busyTimes.some((busy) => {
    const busyMs = busy.getTime();
    return Number.isFinite(busyMs) && Math.abs(candidateMs - busyMs) < minGapMs;
  });
}

export function selectSafeSlots(
  candidates: Date[],
  busyTimes: Date[],
  needed: number,
  minGapMinutes = MIN_POST_INTERVAL_MINUTES
): Date[] {
  const selected: Date[] = [];
  for (const candidate of candidates) {
    if (hasPostIntervalConflict(candidate, [...busyTimes, ...selected], minGapMinutes)) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= needed) break;
  }
  return selected;
}
