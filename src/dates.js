import { t } from "./i18n.js";

// Dates are local "YYYY-MM-DD" strings throughout; they sort lexically.

export const today = () => new Date().toLocaleDateString("sv");

export function addDays(date, n) {
  const d = new Date(date + "T00:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv");
}

// Monday of the week containing `date`
export function weekStart(date) {
  const day = new Date(date + "T00:00").getDay();
  return addDays(date, -((day + 6) % 7));
}

export const weekday = (date) => t("weekday.label", new Date(date + "T00:00").getDay());

// The two ways a date is shown, both following the interface language:
//   longDate   2026 年 10 月 23 日 / Oct 23, 2026   (headings, date links, input)
//   md         10/23 / Oct 23                      (badges, lists, agenda)
// Stored and exported dates stay "YYYY-MM-DD".
const parts = (date) => date.split("-").map(Number);
export const longDate = (date) => t("date.heading", ...parts(date));
export function md(date) {
  const [, m, d] = parts(date);
  return t("date.short", m, d);
}

// What a typed date means, in every way people write one: as a list of
// "YYYY-MM-DD", every reading that is a real date, the likelier first and
// none twice. Separators are - / . or 年月日/號; a 2-digit year is 20xx, a
// 3-digit one a 民國 year; a month may be an English name or its first
// letters (oct, sept); a missing year is this year. Two numbers or three
// without a 4-digit year are read both month-first and day-first (10/11 is
// Oct 11 and Nov 10), so whichever habit wrote it, the day meant is there.
//   2026-10-29  2026/10/29  2026.10.29  2026年10月29日  115/10/29
//   10/29/2026  29/10/2026  10-29-26  29.10.26  10/29  29/10  10月29日
//   20261029  10292026  261029  1029  129  (digits alone, cut every way)
//   oct 29  oct29  oct 29, 2026  october 29th 2026  29 oct  29oct  29 october 2026
//   today  tomorrow  yesterday  今天  明天  昨天  後天  前天
const RELATIVE = { today: 0, tomorrow: 1, yesterday: -1, 今天: 0, 今日: 0, 明天: 1, 明日: 1, 昨天: -1, 昨日: -1, 後天: 2, 前天: -2 };
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthNamed = (w) => (w = w.replace(/\.$/, ""), w.length < 3 && w !== "may" ? 0 : MONTH_NAMES.findIndex((m) => m.startsWith(w) || (w === "sept" && m === "september")) + 1);
const fullYear = (y) => (y = Number(y), y < 100 ? 2000 + y : y < 1000 ? 1911 + y : y);
const SEP = "[-/.]";
const NUM3 = new RegExp(`^(\\d{1,4})${SEP}(\\d{1,2})${SEP}(\\d{1,4})$`);
const NUM2 = new RegExp(`^(\\d{1,2})(?:${SEP}|月\\s*)(\\d{1,2})\\s*[日號]?$`);
const YMD_CJK = /^(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]?$/;
const ORD = "(?:st|nd|rd|th)?";
const MDY_EN = new RegExp(`^([a-z]{3,9}\\.?)\\s*(\\d{1,2})${ORD}(?:,?\\s+(\\d{2}|\\d{4}))?$`);
const DMY_EN = new RegExp(`^(\\d{1,2})${ORD}\\s*(?:of\\s+)?([a-z]{3,9}\\.?)(?:,?\\s+(\\d{2}|\\d{4}))?$`);

export function parseDates(text, base = today()) {
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return [];
  if (s in RELATIVE) return [addDays(base, RELATIVE[s])];
  const thisYear = Number(base.slice(0, 4));
  const out = [];
  const add = (y, m, d) => {
    [y, m, d] = [Number(y), Number(m), Number(d)];
    if (!(m >= 1 && m <= 12 && d >= 1)) return;
    const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (new Date(iso + "T00:00").getDate() !== d || out.includes(iso)) return; // Feb 30, Apr 31 … are not dates
    out.push(iso);
  };
  let m;
  if (/^\d+$/.test(s)) {
    // digits alone, cut every way that makes a date: 1204 is Dec 4 (and
    // Apr 12), 124 is Jan 24, Dec 4 and Apr 12; 261204 and 20261204 too
    const cut = (...widths) => { const parts = []; let k = 0; for (const w of widths) { parts.push(s.slice(k, k + w)); k += w; } return parts; };
    const n = s.length;
    if (n === 8) { const [y, mo, d] = cut(4, 2, 2); add(y, mo, d); const [a, b, yy] = cut(2, 2, 4); add(yy, a, b); add(yy, b, a); }
    else if (n === 6) { const [a, b, c] = cut(2, 2, 2); add(fullYear(a), b, c); add(fullYear(c), a, b); add(fullYear(c), b, a); } // yymmdd first, then mmddyy, ddmmyy
    else if (n === 4) { const [a, b] = cut(2, 2); add(thisYear, a, b); add(thisYear, b, a); }
    else if (n === 3) { const cuts = [cut(1, 2), cut(2, 1)]; for (const [a, b] of cuts) add(thisYear, a, b); for (const [a, b] of cuts) add(thisYear, b, a); }
  }
  else if ((m = YMD_CJK.exec(s))) add(fullYear(m[1]), m[2], m[3]);
  else if ((m = NUM3.exec(s))) {
    const [, a, b, c] = m;
    if (a.length >= 3) add(fullYear(a), b, c); // year first: 2026-10-29, 115/10/29
    else if (c.length <= 2 || c.length === 4) { add(fullYear(c), a, b); add(fullYear(c), b, a); add(fullYear(a), b, c); } // year last, m/d/y then d/m/y; last yy/mm/dd
  } else if ((m = NUM2.exec(s))) { add(thisYear, m[1], m[2]); add(thisYear, m[2], m[1]); }
  else if ((m = MDY_EN.exec(s)) && monthNamed(m[1])) add(m[3] ? fullYear(m[3]) : thisYear, monthNamed(m[1]), m[2]);
  else if ((m = DMY_EN.exec(s)) && monthNamed(m[2])) add(m[3] ? fullYear(m[3]) : thisYear, monthNamed(m[2]), m[1]);
  return out;
}

// A date typed only so far: a year (2027, 2027-, 2027年), or a year and
// month (2027-01, 2027/1/, 2027年1月). { year, month? } for the picker to
// say what is still to come; null for anything else.
export function partialDate(text) {
  const s = text.trim();
  let m;
  if ((m = /^(\d{4})(?:\s*[-/.年]\s*(?:(\d{1,2})\s*[-/.月]?\s*)?)?$/.exec(s)) && m[1] >= 1900 && m[1] <= 2200) {
    if (m[2] === undefined) return { year: Number(m[1]) };
    if (m[2] >= 1 && m[2] <= 12) return { year: Number(m[1]), month: Number(m[2]) };
  }
  return null;
}
