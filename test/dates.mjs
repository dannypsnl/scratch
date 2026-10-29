// A typed date in any habit (dates.js parseDates): year first, month
// first, day first, Chinese, English month names, relative words; every
// real reading of an ambiguous one, none twice, and nothing for a non-date.
import { parseDates, partialDate } from "../src/dates.js";

const BASE = "2026-10-29";
const fails = [];
const check = (text, want) => {
  const got = parseDates(text, BASE).join(" ");
  if (got !== want.join(" ")) fails.push(`${JSON.stringify(text)} → ${got || "(nothing)"}, wanted ${want.join(" ") || "(nothing)"}`);
};

for (const s of ["2026-10-29", "2026/10/29", "2026.10.29", "20261029", "2026年10月29日", "2026年10月29號", "2026 年 10 月 29 日", "2026-10-29"])
  check(s, ["2026-10-29"]);
check("115/10/29", ["2026-10-29"]); // 民國
check("26/10/29", ["2029-10-26", "2026-10-29"]); // d/m/y, or yy/mm/dd
check("10/29/2026", ["2026-10-29"]);
check("29/10/2026", ["2026-10-29"]);
check("10-29-26", ["2026-10-29"]);
check("29.10.26", ["2026-10-29", "2029-10-26"]); // d/m/y, or yy/mm/dd
check("10/11/2026", ["2026-10-11", "2026-11-10"]); // either habit
check("3/4", ["2026-03-04", "2026-04-03"]);
check("10/29", ["2026-10-29"]);
check("29/10", ["2026-10-29"]);
check("10月29日", ["2026-10-29"]);
check("10月29號", ["2026-10-29"]);
check("oct 29", ["2026-10-29"]);
check("oct29", ["2026-10-29"]);
check("29oct", ["2026-10-29"]);
// digits alone
check("1204", ["2026-12-04", "2026-04-12"]);
check("1029", ["2026-10-29"]);
check("0405", ["2026-04-05", "2026-05-04"]);
check("124", ["2026-01-24", "2026-12-04", "2026-04-12"]);
check("129", ["2026-01-29", "2026-12-09", "2026-09-12"]);
check("261204", ["2026-12-04", "2004-12-26"]); // yymmdd, then ddmmyy
check("120426", ["2012-04-26", "2026-12-04", "2026-04-12"]);
check("10292026", ["2026-10-29"]);
check("20261204", ["2026-12-04"]);
check("12042026", ["2026-12-04", "2026-04-12"]);
check("1313", []);
check("12", []); // one number alone names no day
check("Oct. 29, 2026", ["2026-10-29"]);
check("October 29th 2026", ["2026-10-29"]);
check("29 oct", ["2026-10-29"]);
check("29th of October, 2026", ["2026-10-29"]);
check("sept 5", ["2026-09-05"]);
check("may 5", ["2026-05-05"]);
check("today", ["2026-10-29"]);
check("tomorrow", ["2026-10-30"]);
check("yesterday", ["2026-10-28"]);
check("明天", ["2026-10-30"]);
check("後天", ["2026-10-31"]);
check("前天", ["2026-10-27"]);
check("2026-02-30", []); // not a date
check("13/13", []);
check("2026-13-01", []);
check("Health", []);
check("ma 5", []); // too short to name a month
check("1.5", ["2026-01-05", "2026-05-01"]);
check("", []);

// a date typed only so far
const part = (text, want) => {
  const got = JSON.stringify(partialDate(text));
  if (got !== JSON.stringify(want)) fails.push(`partial ${JSON.stringify(text)} → ${got}, wanted ${JSON.stringify(want)}`);
};
part("2027", { year: 2027 });
part("2027-", { year: 2027 });
part("2027年", { year: 2027 });
part("2027-01", { year: 2027, month: 1 });
part("2027/1/", { year: 2027, month: 1 });
part("2027年1月", { year: 2027, month: 1 });
part("2027-13", null);
part("1204", null); // a day, not a year
part("202", null);
part("Health", null);

console.log(`dates: ${fails.length} problems`);
for (const f of fails) console.log("  " + f);
if (fails.length) process.exit(1);
