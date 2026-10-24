import { schema } from "./schema.js";
import { SYMBOLS } from "./specs.js";
import { parseMath } from "./latex.js";

const T = schema.nodes;

// Simplify / Factor / Expand through Nerdamer, loaded on first use.
// A selection goes to Nerdamer as its own plain syntax (2ab -> 2*a*b), built
// from the formula's structure: its LaTeX reader would take "ab" for one
// variable. The answer comes back as LaTeX, tidied for parseMath.

const FUNCS = { sin: "sin", cos: "cos", tan: "tan", log: "log", ln: "log", exp: "exp" };
const BINOPS = { cdot: "*", times: "*" };

class NotAlgebra extends Error {}
const refuse = () => { throw new NotAlgebra(); };

// tokens: { k: "val" | "open" | "close" | "op" | "fn" | "post", s }
// "val" and "close" followed by "val", "open" or "fn" get a "*" between them.
function tokens(frag, out = []) {
  frag.forEach((n) => {
    if (n.isText) {
      for (const m of n.text.matchAll(/[0-9]+(?:\.[0-9]+)?|[A-Za-z]|[-+*/()]|\s+|./g)) {
        const s = m[0];
        if (/^\s/.test(s)) continue;
        if (/^[0-9A-Za-z]/.test(s)) out.push({ k: "val", s });
        else if (s === "(") out.push({ k: "open", s });
        else if (s === ")") out.push({ k: "close", s });
        else if ("+-*/".includes(s)) out.push({ k: "op", s });
        else refuse(); // = < > , and anything else: not one expression
      }
    } else if (n.type === T.sym) {
      const name = n.attrs.name, s = SYMBOLS[name];
      if (BINOPS[name]) out.push({ k: "op", s: BINOPS[name] });
      else if (FUNCS[name]) out.push({ k: "fn", s: FUNCS[name] });
      else if (s?.cls === "ord" && s.italic) out.push({ k: "val", s: name }); // Greek letters
      else refuse();
    } else if (n.type === T.struct) {
      const arg = (i) => expr(n.child(i).content);
      switch (n.attrs.name) {
        case "frac": case "dfrac": out.push({ k: "val", s: `((${arg(0)})/(${arg(1)}))` }); break;
        case "sqrt": out.push({ k: "val", s: `sqrt(${arg(0)})` }); break;
        default: refuse();
      }
    } else if (n.type === T.sup) {
      out.push({ k: "post", s: `^(${expr(n.content)})` });
    } else if (n.type === T.sub) {
      // x_1, x_{ij}: part of the variable's name
      const last = out[out.length - 1];
      const name = n.textContent;
      if (last?.k !== "val" || !/^[A-Za-z]$|^[A-Za-z][A-Za-z0-9]*_?$/.test(last.s) || !/^[A-Za-z0-9]+$/.test(name)) refuse();
      last.s += "_" + name;
    } else refuse();
  });
  return out;
}

function expr(frag) {
  const ts = tokens(frag);
  if (!ts.length) refuse();
  let s = "", prev = null;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (prev && (prev.k === "val" || prev.k === "close" || prev.k === "post") && (t.k === "val" || t.k === "open" || t.k === "fn")) s += "*";
    if (t.k === "fn") {
      // sin x -> sin(x); sin(x) stays
      const next = ts[i + 1];
      if (!next) refuse();
      if (next.k === "val") { s += `${t.s}(${next.s})`; prev = { k: "close" }; i++; continue; }
      // sin^2 x -> sin(x)^(2)
      if (next.k === "post" && ts[i + 2]?.k === "val") { s += `${t.s}(${ts[i + 2].s})${next.s}`; prev = { k: "close" }; i += 2; continue; }
      if (next.k !== "open") refuse();
    }
    s += t.s;
    prev = t;
  }
  return s;
}

// The selection as Nerdamer input, or null when it is not an algebraic
// expression (relations, arrows, \mathbb …) or has nothing to work on.
export function toCas(frag) {
  try {
    const s = expr(frag);
    return /[-+*/^(]/.test(s) ? s : null;
  } catch (e) {
    if (e instanceof NotAlgebra) return null;
    throw e;
  }
}

// Nerdamer's LaTeX -> what parseMath reads
function tidy(tex) {
  let s = tex.replace(/\\left|\\right/g, "");
  // 3 \cdot a -> 3a, but 2 \cdot 3 keeps its dot
  s = s.replace(/\s*\\cdot\s*/g, (m, at) => (/[0-9]$/.test(s.slice(0, at)) && /^[0-9]/.test(s.slice(at + m.length)) ? "\\cdot " : ""));
  // \sqrt[n]{x} -> (x)^{\frac{1}{n}}: there is no n-th root here
  for (;;) {
    const m = /\\sqrt\[([^\]]+)\]\{/.exec(s);
    if (!m) break;
    let depth = 1, k = m.index + m[0].length;
    for (; k < s.length && depth; k++) depth += s[k] === "{" ? 1 : s[k] === "}" ? -1 : 0;
    const body = s.slice(m.index + m[0].length, k - 1);
    const base = /^[A-Za-z0-9]$/.test(body) ? body : `(${body})`;
    s = s.slice(0, m.index) + `${base}^{\\frac{1}{${m[1]}}}` + s.slice(k);
  }
  return s;
}

let loading = null;
const load = () => (loading ??= import("nerdamer").then((m) => m.default ?? m));

// op: "simplify" | "factor" | "expand". Resolves to the result's nodes, or
// null when Nerdamer could not do anything with it.
export async function runCas(op, input) {
  const N = await load();
  let r;
  try {
    r = op === "expand" ? N(input).expand() : N[op](input);
  } catch {
    return null;
  }
  return parseMath(tidy(r.toTeX()));
}
