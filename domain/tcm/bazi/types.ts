export type City = { nameZh: string; nameEn: string; longitude: number; timeZone: string }
export type Birth = {
  date: string; city: City; time?: string | null;
  /** Half-open local clock interval on the birth date; end may be 24:00. */
  timeRange?: { start: string; end: string };
  occurrence?: 'earlier' | 'later';
}
export type Options = { trueSolarTime?: boolean; ziHourRule?: 'nextDay' | 'sameDay' }
type YearMonth = { year: string; month: string }
export type BaziResult = {
  year: string | null; month: string | null; day: string; hour: string | null;
  flags: ('时柱缺' | '出生时刻重复')[];
  ambiguous?: { pillars: ('year' | 'month')[]; term: string; termTime: string; before: YearMonth; after: YearMonth };
  repeatedTime?: { selected: 'earlier' | 'later'; choices: ['earlier', 'later'] };
}
