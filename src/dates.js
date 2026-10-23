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
