import { Market } from './types';
import { readJsonFile, writeJsonFile } from './cache';
import { httpGet } from './providers';

const HOLIDAY_FILE = 'vscode-stock-watcher-holidays.json';

interface HolidayCache {
  years: number[];
  map: Record<string, boolean>; // 'YYYY-MM-DD' -> isOffDay（true=放假，false=调休上班）
}

let holidays: Record<string, boolean> = {};

/** 北京时间「现在」（不依赖本机时区） */
function beijingNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 8 * 60) * 60 * 1000);
}

function hm(d: Date): number {
  return d.getHours() * 100 + d.getMinutes();
}

function ymd(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 加载法定节假日（holiday-cn 的 jsdelivr CDN），缓存到临时文件（含今明两年）。
 * 失败则静默降级为仅按周末判断。应用启动时调用一次。
 */
export async function loadHolidays(): Promise<void> {
  const nowYear = beijingNow().getFullYear();
  const cached = readJsonFile<HolidayCache>(HOLIDAY_FILE);
  if (cached && cached.years.includes(nowYear) && cached.years.includes(nowYear + 1)) {
    holidays = cached.map;
    return;
  }
  const map: Record<string, boolean> = { ...(cached?.map ?? {}) };
  const years = [nowYear, nowYear + 1];
  for (const y of years) {
    try {
      const raw = await httpGet(`https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`, 'utf8');
      const json = JSON.parse(raw) as { days: { date: string; isOffDay: boolean }[] };
      for (const d of json.days) {
        map[d.date] = d.isOffDay;
      }
    } catch (e) {
      console.error('[stock-watcher] loadHolidays failed for', y, e);
    }
  }
  holidays = map;
  writeJsonFile(HOLIDAY_FILE, { years, map } satisfies HolidayCache);
}

/** 该日是否休市（A 股口径）：优先用节假日数据，无数据降级周末判断 */
function isCnOffDay(d: Date): boolean {
  const key = ymd(d);
  if (key in holidays) {
    return holidays[key]; // true=放假，false=调休上班（开市）
  }
  const wd = d.getDay();
  return wd === 0 || wd === 6;
}

/**
 * A 股连续竞价时段（纯函数，便于测试）。
 * @param day 0=周日 … 6=周六；@param t 时*100+分
 */
export function isTradingTime(day: number, t: number): boolean {
  if (day === 0 || day === 6) {
    return false;
  }
  return (t >= 930 && t <= 1130) || (t >= 1300 && t <= 1500);
}

function cnOpen(d: Date): boolean {
  if (isCnOffDay(d)) {
    return false;
  }
  const t = hm(d);
  return (t >= 930 && t <= 1130) || (t >= 1300 && t <= 1500);
}

/** 港股：节假日与大陆不同，这里仅排除周末（大陆节假日重叠时最多多刷一次，无害） */
function hkOpen(d: Date): boolean {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) {
    return false;
  }
  const t = hm(d);
  return (t >= 930 && t <= 1200) || (t >= 1300 && t <= 1600);
}

/** 该 UTC 时刻是否处于美东夏令时（3 月第 2 个周日 ~ 11 月第 1 个周日，纯函数便于测试） */
export function isUsDST(utc: Date): boolean {
  const y = utc.getUTCFullYear();
  const firstSunday = (month: number) => {
    const first = new Date(Date.UTC(y, month, 1));
    return 1 + ((7 - first.getUTCDay()) % 7);
  };
  const dstStart = Date.UTC(y, 2, firstSunday(2) + 7); // 3 月第 2 个周日
  const dstEnd = Date.UTC(y, 10, firstSunday(10)); // 11 月第 1 个周日
  const ms = utc.getTime();
  return ms >= dstStart && ms < dstEnd;
}

/** 美股：按美东时区判断（精确夏令时），9:30-16:00 ET；不含美股节假日 / 盘前盘后。 */
function usOpen(): boolean {
  const now = new Date(); // 真实 UTC 基准
  const etOffsetH = isUsDST(now) ? 4 : 5; // EDT=UTC-4 / EST=UTC-5
  const et = new Date(now.getTime() - etOffsetH * 3600 * 1000);
  const wd = et.getUTCDay();
  if (wd === 0 || wd === 6) {
    return false; // 美东周末
  }
  const etHm = et.getUTCHours() * 100 + et.getUTCMinutes();
  return etHm >= 930 && etHm <= 1600;
}

/** 指定市场当前是否开盘 */
export function isMarketOpen(market: Market): boolean {
  const d = beijingNow();
  switch (market) {
    case 'cn':
    case 'fund':
      return cnOpen(d);
    case 'hk':
      return hkOpen(d);
    case 'us':
      return usOpen();
    default:
      return cnOpen(d);
  }
}
