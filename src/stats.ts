/**
 * 阅读统计：只做两件事
 *  1. 把每次阅读的时长累加到「日期 → 秒」的账本里（localStorage）
 *  2. 提供按天/按周/按月的整理工具，给「阅读见解」页用
 *
 * 这个账本从第一次运行这一版开始记，所以历史时长是 0 而不是猜出来的。
 */

const SECONDS_KEY = "tauriview.readseconds";

const pad = (n: number): string => String(n).padStart(2, "0");

/** 本地时区的日期键：2026-10-24 */
export function dayKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type SecondsLog = Record<string, number>;

export function loadSeconds(): SecondsLog {
  try {
    const raw = localStorage.getItem(SECONDS_KEY);
    const parsed = raw ? (JSON.parse(raw) as SecondsLog) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSeconds(log: SecondsLog): void {
  try {
    localStorage.setItem(SECONDS_KEY, JSON.stringify(log));
  } catch {
    /* 存不下就只在本次生效 */
  }
}

/** 累加一次阅读时长；太短的（误触）与离谱的（挂机）都丢掉 */
export function addReadingMs(ms: number, at: Date = new Date()): void {
  if (!Number.isFinite(ms) || ms < 3000 || ms > 3 * 60 * 60 * 1000) return;
  const log = loadSeconds();
  const key = dayKey(at);
  log[key] = (log[key] ?? 0) + Math.round(ms / 1000);
  saveSeconds(log);
}

/** 从「有阅读活动」的日期集合里算连续天数（今天没读则从昨天往前算） */
export function streakDays(days: Set<string>, now: Date = new Date()): number {
  let streak = 0;
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** 最长连续天数记录，附起止日期 */
export function maxStreakRange(days: Set<string>): { length: number; start?: string; end?: string } {
  const sorted = [...days].sort();
  let best = { length: 0, start: undefined as string | undefined, end: undefined as string | undefined };
  let runStart: string | undefined;
  let prev: Date | undefined;
  let run = 0;
  for (const key of sorted) {
    const d = new Date(`${key}T00:00:00`);
    if (prev && Math.round((d.getTime() - prev.getTime()) / 86400000) === 1) {
      run++;
    } else {
      run = 1;
      runStart = key;
    }
    if (run > best.length) best = { length: run, start: runStart, end: key };
    prev = d;
  }
  return best;
}

/** 最长连续周记录，附起止日期（周一为一周起点） */
export function maxWeekStreakRange(days: Set<string>): { length: number; start?: string; end?: string } {
  const weekKey = (d: Date): string => {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  };
  const weeks = new Map<string, string[]>();
  for (const key of [...days].sort()) {
    const wk = weekKey(new Date(`${key}T00:00:00`));
    const arr = weeks.get(wk);
    if (arr) arr.push(key);
    else weeks.set(wk, [key]);
  }
  const keys = [...weeks.keys()].sort();
  let best = { length: 0, start: undefined as string | undefined, end: undefined as string | undefined };
  let runStart: string | undefined;
  let prev: Date | undefined;
  let run = 0;
  for (const wk of keys) {
    const d = new Date(`${wk}T00:00:00`);
    if (prev && Math.round((d.getTime() - prev.getTime()) / (7 * 86400000)) === 1) {
      run++;
    } else {
      run = 1;
      runStart = wk;
    }
    if (run > best.length) {
      const last = weeks.get(wk)!;
      best = { length: run, start: runStart, end: last[last.length - 1] };
    }
    prev = d;
  }
  return best;
}

/** 周连续：以周一为一周起点 */
export function streakWeeks(days: Set<string>, now: Date = new Date()): number {
  const weekStart = (d: Date): Date => {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const shift = (t.getDay() + 6) % 7; // 周一 = 0
    t.setDate(t.getDate() - shift);
    return t;
  };
  const hasWeek = (start: Date): boolean => {
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (days.has(dayKey(d))) return true;
    }
    return false;
  };
  let cursor = weekStart(now);
  if (!hasWeek(cursor)) cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 7);
  let streak = 0;
  while (hasWeek(cursor)) {
    streak++;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 7);
  }
  return streak;
}
