import { today, addDays } from "./dates.js";

// GitHub-style filter text, e.g.  -status:done has:deadline deadline:<+7d proof
//   status:todo,doing   has:deadline   no:deadline   is:overdue
//   deadline:<2026-11-01   date:>=today   deadline:<+7d   link:拓樸 (= tag:)
//   completed:>=-7d (done within the last week)   has:completed
//   (plain words match text)
// A leading "-" negates any term.

function resolveDate(v) {
  if (v === "today") return today();
  const rel = /^([+-]\d+)d$/.exec(v);
  return rel ? addDays(today(), Number(rel[1])) : v;
}

function compare(field, v) {
  const [, op = "=", raw] = /^(<=|>=|<|>)?(.*)$/.exec(v);
  const d = resolveDate(raw);
  const ops = { "=": (x) => x === d, "<": (x) => x < d, ">": (x) => x > d, "<=": (x) => x <= d, ">=": (x) => x >= d };
  return (t) => !!t[field] && ops[op](t[field]);
}

function term(tok) {
  const m = /^(\w+):(.+)$/.exec(tok);
  if (!m) {
    const w = tok.toLowerCase();
    return (t) => t.text.toLowerCase().includes(w);
  }
  const [, key, v] = m;
  switch (key) {
    case "status": { const set = v.split(","); return (t) => set.includes(t.task); }
    case "link":
    case "tag": { const k = v.toLowerCase(); return (t) => t.links.some((l) => l.toLowerCase() === k); }
    case "has": return (t) => !!t[v];
    case "no": return (t) => !t[v];
    case "is": return v === "overdue" ? (t) => !!t.deadline && t.deadline < today() && t.task !== "done" : () => true;
    case "deadline":
    case "date":
    case "completed": return compare(key, v);
    default: return () => true;
  }
}

export function compileFilter(q) {
  const preds = q.trim().split(/\s+/).filter(Boolean).map((tok) => {
    if (tok.startsWith("-") && tok.length > 1) { const p = term(tok.slice(1)); return (t) => !p(t); }
    return term(tok);
  });
  return (t) => preds.every((p) => p(t));
}
