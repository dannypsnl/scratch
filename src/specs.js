// Declarative tables. Adding a command = adding a row here.
import { KATEX_SYMBOLS } from "./katex-symbols.js";

// Zero-argument commands: rendered as one glyph.
// cls: "ord" (ordinary), "bin" (binary op), "rel" (relation), "op" (large operator),
//      "opname" (an operator written as a word: \ker, \sin)
// italic: rendered in KaTeX_Math italic (Latin-like variables, lowercase Greek)
const sym = (char, cls = "ord", italic = false) => ({ char, cls, italic });
// Blackboard shorthands (\Z, \R, …) are the user's macros, exported as written;
// the publisher needs the same macro definitions.
const opname = (name) => ({ char: name, cls: "opname", italic: false, preview: `\\operatorname{${name}}` });
const opnames = (...names) => Object.fromEntries(names.map((n) => [n, opname(n)]));
const bb = (letter) => ({ char: letter, cls: "ord", italic: false, bb: true, preview: `\\mathbb{${letter}}` });

// Every symbol KaTeX knows (generated: scripts/katex-symbols.mjs); the rows
// written out below take precedence.
const fromKatex = Object.fromEntries(Object.entries(KATEX_SYMBOLS).map(([name, [char, cls, font, italic]]) =>
  [name, { char, cls, italic: !!italic, ams: font === "ams" }]));

// Operators whose scripts are limits, above and below them (as TeX sets them
// in display style: \sum_{n=1}^N); the others keep theirs at the side (\int)
export const LIMITS = new Set(["sum", "prod", "coprod", "bigcup", "bigcap", "bigsqcup", "bigvee", "bigwedge",
  "bigodot", "bigoplus", "bigotimes", "biguplus", "lim", "liminf", "limsup", "max", "min", "sup", "inf", "det",
  "gcd", "Pr", "injlim", "projlim", "varliminf", "varlimsup", "varinjlim", "varprojlim"]);

// The commands written out here come first when the \ menu lists a family
// (every arrow for "arrow"): the common ones, in this order.
const COMMON = {
  // lowercase Greek
  alpha: sym("α", "ord", true), beta: sym("β", "ord", true), gamma: sym("γ", "ord", true),
  delta: sym("δ", "ord", true), epsilon: sym("ϵ", "ord", true), varepsilon: sym("ε", "ord", true),
  zeta: sym("ζ", "ord", true), eta: sym("η", "ord", true), theta: sym("θ", "ord", true),
  iota: sym("ι", "ord", true), kappa: sym("κ", "ord", true), lambda: sym("λ", "ord", true),
  mu: sym("μ", "ord", true), nu: sym("ν", "ord", true), xi: sym("ξ", "ord", true),
  pi: sym("π", "ord", true), rho: sym("ρ", "ord", true), sigma: sym("σ", "ord", true),
  tau: sym("τ", "ord", true), phi: sym("ϕ", "ord", true), varphi: sym("φ", "ord", true),
  chi: sym("χ", "ord", true), psi: sym("ψ", "ord", true), omega: sym("ω", "ord", true),
  // uppercase Greek
  Gamma: sym("Γ"), Delta: sym("Δ"), Theta: sym("Θ"), Lambda: sym("Λ"), Xi: sym("Ξ"),
  Pi: sym("Π"), Sigma: sym("Σ"), Phi: sym("Φ"), Psi: sym("Ψ"), Omega: sym("Ω"),
  // binary operators
  cdot: sym("⋅", "bin"), times: sym("×", "bin"), circ: sym("∘", "bin"), otimes: sym("⊗", "bin"),
  oplus: sym("⊕", "bin"), cup: sym("∪", "bin"), cap: sym("∩", "bin"), wedge: sym("∧", "bin"),
  vee: sym("∨", "bin"), pm: sym("±", "bin"), setminus: sym("∖", "bin"), bullet: sym("∙", "bin"),
  // relations
  le: sym("≤", "rel"), leq: sym("≤", "rel"), ge: sym("≥", "rel"), geq: sym("≥", "rel"),
  neq: sym("≠", "rel"), equiv: sym("≡", "rel"), cong: sym("≅", "rel"), simeq: sym("≃", "rel"),
  sim: sym("∼", "rel"), approx: sym("≈", "rel"), in: sym("∈", "rel"), notin: sym("∉", "rel"),
  subset: sym("⊂", "rel"), subseteq: sym("⊆", "rel"), supseteq: sym("⊇", "rel"),
  to: sym("→", "rel"), rightarrow: sym("→", "rel"), leftarrow: sym("←", "rel"),
  leftrightarrow: sym("↔", "rel"), mapsto: sym("↦", "rel"), Rightarrow: sym("⇒", "rel"), iff: sym("⟺", "rel"),
  hookrightarrow: sym("↪", "rel"), rightarrowtail: sym("↣", "rel"), twoheadrightarrow: sym("↠", "rel"), vdash: sym("⊢", "rel"),
  // ⇸, a partial map: in no KaTeX font and not a KaTeX command. Drawn as \to
  // with a short bar over its middle (schema.js); the preview kerns the bar
  // back over \to (not in a \mathrel: KaTeX's MathML for that nests <mo>,
  // which the HTML parser mangles, taking the visible HTML with it). Written
  // as Z notation's \pfun, a macro the publisher needs like \Z.
  pfun: { char: "⇸", cls: "rel", italic: false, drawn: ["→", "∣"], preview: "\\to\\mkern-11.5mu\\shortmid\\mkern6.5mu" },
  // number systems
  N: bb("N"), Z: bb("Z"), Q: bb("Q"), R: bb("R"), C: bb("C"), F: bb("F"), P: bb("P"),
  // misc
  infty: sym("∞"), partial: sym("∂"), nabla: sym("∇"), forall: sym("∀"), exists: sym("∃"),
  ldots: sym("…"), cdots: sym("⋯"), emptyset: sym("∅"), ell: sym("ℓ", "ord", true), top: sym("⊤"), bot: sym("⊥"),
  // spacing (\, \: \; \! keep their one-character names)
  quad: sym(" "), qquad: sym("  "), enspace: sym(" "), thinspace: sym(" "),
  medspace: sym(" "), thickspace: sym(" "), ",": sym(" "), ":": sym(" "), ";": sym(" "), "!": sym(""),
  // large operators
  sum: sym("∑", "op"), prod: sym("∏", "op"), int: sym("∫", "op"), coprod: sym("∐", "op"),
  // operator names; rank, Hom, End, Aut, id, im, coker, lcm, tr are not
  // LaTeX built-ins, so like \Z the publisher needs them defined (\operatorname)
  ...opnames("ker", "dim", "deg", "det", "rank", "hom", "Hom", "End", "Aut", "id", "im", "coker",
    "sin", "cos", "tan", "log", "ln", "exp", "lim", "sup", "inf", "max", "min", "arg", "gcd", "lcm", "mod", "Pr", "tr",
    "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth", "cot", "csc", "sec", "lg", "liminf", "limsup",
    "sh", "ch", "th", "cth", "tg", "ctg", "cotg", "cosec", "arctg", "arcctg"),
  bigcup: sym("⋃", "op"), bigcap: sym("⋂", "op"), bigoplus: sym("⨁", "op"), bigotimes: sym("⨂", "op"),
};
export const SYMBOLS = { ...fromKatex, ...Object.fromEntries(Object.entries(COMMON).map(([name, s], rank) => [name, { ...s, rank }])) };

// A family of symbols, told by the glyph: the \ menu lists every member for
// the family's name. "arrow" is the Unicode arrow blocks (so \to, \mapsto,
// \iff and the harpoons are arrows, whatever their names), and \multimap.
const ARROW_BLOCKS = [[0x2190, 0x21FF], [0x27F0, 0x27FF], [0x2900, 0x297F], [0x2B00, 0x2BFF]];
export const FAMILIES = {
  arrow: (char) => ARROW_BLOCKS.some(([lo, hi]) => char.codePointAt(0) >= lo && char.codePointAt(0) <= hi) || char === "⊸",
};

// Commands with arguments. rows lists slot indices top-to-bottom, used for Up/Down;
// example is what the quick command menu renders as a preview; letter means it
// styles a single letter, taken from the next key press; wrap is the slot a
// selection goes into when the command is run over one (default the first).
// Any command not listed here becomes layout "generic" with however many slots it has.
export const STRUCTS = {
  frac: { arity: 2, layout: "fraction", rows: [[0], [1]], example: "\\frac{a}{b}" },
  dfrac: { arity: 2, layout: "fraction", rows: [[0], [1]], example: "\\dfrac{a}{b}" },
  binom: { arity: 2, layout: "binom", rows: [[0], [1]], example: "\\binom{n}{k}" },
  sqrt: { arity: 1, layout: "radical", rows: [[0]], example: "\\sqrt{x}" },
  overset: { arity: 2, layout: "overset", rows: [[0], [1]], wrap: 1, example: "\\overset{f}{\\to}" },
  underset: { arity: 2, layout: "underset", rows: [[1], [0]], wrap: 1, example: "\\underset{n}{\\lim}" },
  overline: { arity: 1, layout: "overline", rows: [[0]], example: "\\overline{z}" },
  mathbb: { arity: 1, layout: "font-bb", rows: [[0]], example: "\\mathbb{R}", letter: true },
  mathcal: { arity: 1, layout: "font-cal", rows: [[0]], example: "\\mathcal{C}", letter: true },
  mathrm: { arity: 1, layout: "font-rm", rows: [[0]], example: "\\mathrm{d}x" },
  operatorname: { arity: 1, layout: "opname", rows: [[0]], example: "\\operatorname{rank}" },
  // the other forms KaTeX has
  tfrac: { arity: 2, layout: "fraction", rows: [[0], [1]], example: "\\tfrac{a}{b}", small: true },
  cfrac: { arity: 2, layout: "fraction", rows: [[0], [1]], example: "\\cfrac{a}{b}" },
  dbinom: { arity: 2, layout: "binom", rows: [[0], [1]], example: "\\dbinom{n}{k}" },
  tbinom: { arity: 2, layout: "binom", rows: [[0], [1]], example: "\\tbinom{n}{k}" },
  stackrel: { arity: 2, layout: "overset", rows: [[0], [1]], wrap: 1, example: "\\stackrel{f}{=}" },
  underline: { arity: 1, layout: "underline", rows: [[0]], example: "\\underline{x}" },
  boxed: { arity: 1, layout: "boxed", rows: [[0]], example: "\\boxed{x}" },
  // accents: a mark over the argument
  ...accents({ hat: "ˆ", bar: "ˉ", vec: "→", tilde: "˜", dot: "˙", ddot: "¨", acute: "ˊ", grave: "ˋ", breve: "˘",
    check: "ˇ", mathring: "˚" }),
  // stretching over or under the argument, drawn with KaTeX's own shapes
  // (katex-stretchy.css, generated)
  ...stretchy("accent", "widehat", "widetilde", "widecheck", "overrightarrow", "overleftarrow", "overleftrightarrow",
    "Overrightarrow", "overleftharpoon", "overrightharpoon", "overlinesegment", "overgroup"),
  ...stretchy("accent-under", "underrightarrow", "underleftarrow", "underleftrightarrow", "underlinesegment", "undergroup", "utilde"),
  // a brace with a label: \overbrace{x+y}^{n} (label first, on top), \underbrace{x+y}_{n}
  overbrace: { arity: 2, layout: "overbrace", rows: [[0], [1]], wrap: 1, example: "\\overbrace{x+y}^{n}", stretchy: true, label: "^" },
  overbracket: { arity: 2, layout: "overbrace", rows: [[0], [1]], wrap: 1, example: "\\overbracket{x+y}^{n}", stretchy: true, label: "^" },
  underbrace: { arity: 2, layout: "underbrace", rows: [[0], [1]], example: "\\underbrace{x+y}_{n}", stretchy: true, label: "_" },
  underbracket: { arity: 2, layout: "underbrace", rows: [[0], [1]], example: "\\underbracket{x+y}_{n}", stretchy: true, label: "_" },
  // fonts
  mathbf: { arity: 1, layout: "font-bf", rows: [[0]], example: "\\mathbf{v}" },
  mathit: { arity: 1, layout: "font-it", rows: [[0]], example: "\\mathit{diff}" },
  mathsf: { arity: 1, layout: "font-sf", rows: [[0]], example: "\\mathsf{G}" },
  mathtt: { arity: 1, layout: "font-tt", rows: [[0]], example: "\\mathtt{x}" },
  mathfrak: { arity: 1, layout: "font-frak", rows: [[0]], example: "\\mathfrak{g}", letter: true },
  mathscr: { arity: 1, layout: "font-scr", rows: [[0]], example: "\\mathscr{L}", letter: true },
  mathnormal: { arity: 1, layout: "font-normal", rows: [[0]], example: "\\mathnormal{x}" },
  boldsymbol: { arity: 1, layout: "font-bsym", rows: [[0]], example: "\\boldsymbol{\\alpha}" },
  bm: { arity: 1, layout: "font-bsym", rows: [[0]], example: "\\bm{x}" },
  // text: words with their spaces kept (a space typed in it is a space)
  text: { arity: 1, layout: "font-rm", rows: [[0]], example: "\\text{if}", text: true },
  textrm: { arity: 1, layout: "font-rm", rows: [[0]], example: "\\textrm{if}", text: true },
  textbf: { arity: 1, layout: "font-bf", rows: [[0]], example: "\\textbf{if}", text: true },
  textit: { arity: 1, layout: "font-textit", rows: [[0]], example: "\\textit{if}", text: true },
  textsf: { arity: 1, layout: "font-sf", rows: [[0]], example: "\\textsf{if}", text: true },
  texttt: { arity: 1, layout: "font-tt", rows: [[0]], example: "\\texttt{if}", text: true },
  // \sqrt[n]{x}: the index is a slot of its own
  root: { arity: 2, layout: "root", rows: [[0], [1]], wrap: 1, example: "\\sqrt[n]{x}" },
  // \left( … \right) and kin: delimiters as tall as what they hold (named by
  // how they start; the LaTeX is written by latex.js)
  ...Object.fromEntries([["(", ")", "paren"], ["[", "]", "bracket"], ["|", "|", "vert"], ["\\|", "\\|", "Vert"]].map(([open, close, shape]) =>
    [`left${open}`, { arity: 1, layout: "delim", rows: [[0]], delim: [open, close], shape, example: `\\left${open}x\\right${close}` }])),
};

function stretchy(layout, ...names) {
  return Object.fromEntries(names.map((name) => [name, { arity: 1, layout, rows: [[0]], example: `\\${name}{AB}`, stretchy: true }]));
}

function accents(marks) {
  return Object.fromEntries(Object.entries(marks).map(([name, accent]) =>
    [name, { arity: 1, layout: "accent", rows: [[0]], example: `\\${name}{x}`, accent }]));
}

// \xrightarrow{f} and kin are how an \overset over a lone arrow is written in
// LaTeX (latex.js), \xrightarrow[g]{f} one over an \underset{g}{\to}: in the
// document it is that \overset, every label and the arrow a slot of its own.
// The editor draws the arrow stretched with KaTeX's own shape for the x-arrow
// (katex-stretchy.css). \xtofrom (\rightleftarrows too) and \xlongequal, the
// equilibria: no single symbol to stand for them, so they stay commands.
export const X_ARROWS = Object.fromEntries(Object.entries({
  xrightarrow: "to", xleftarrow: "leftarrow", xRightarrow: "Rightarrow", xLeftarrow: "Leftarrow",
  xleftrightarrow: "leftrightarrow", xLeftrightarrow: "Leftrightarrow", xhookleftarrow: "hookleftarrow",
  xhookrightarrow: "hookrightarrow", xmapsto: "mapsto", xtwoheadrightarrow: "twoheadrightarrow",
  xtwoheadleftarrow: "twoheadleftarrow", xrightharpoonup: "rightharpoonup", xrightharpoondown: "rightharpoondown",
  xleftharpoonup: "leftharpoonup", xleftharpoondown: "leftharpoondown", xrightleftharpoons: "rightleftharpoons",
  xleftrightharpoons: "leftrightharpoons", xrightleftarrows: "rightleftarrows",
}).map(([x, sym]) => [x, { sym }]));
// the arrow symbol -> its x-arrow (\rightarrow is written as \to's)
export const ARROW_X = { rightarrow: "xrightarrow", ...Object.fromEntries(Object.entries(X_ARROWS).map(([x, a]) => [a.sym, x])) };

// ASCII shorthands typed inside a formula, turned into a symbol as soon as
// they are complete. A sequence may continue a symbol made by a shorter one:
// "<=" is ≤ once "=" lands, and a following ">" makes it ⟺; "|-" is ⊢, and
// "|->" ↦ through it. A closing bar starts none: |x|-1 keeps its minus
// (nav.js shorthands). Backspace right after a conversion gives back what
// was typed, so |-1| is |, -, Backspace, 1, |.
export const SHORTHANDS = [
  [["-", ">"], "to"],
  [["-", "\\to"], "longrightarrow"], // -->
  [["|", "-"], "vdash"], // |-
  [["|", "="], "models"], // |=
  [["\\vdash", ">"], "mapsto"], // |->
  [["\\vdash", "\\to"], "longmapsto"], // |-->
  [["-", "\\mapsto"], "pfun"], // -|->
  [[">", "\\to"], "rightarrowtail"], // >->
  [["\\to", ">"], "twoheadrightarrow"], // ->>
  [["~", ">"], "rightsquigarrow"], // ~>
  [["<", "-"], "leftarrow"],
  [["\\leftarrow", ">"], "leftrightarrow"],
  [["\\leftarrow", "<"], "leftarrowtail"], // <-<
  [["<", "\\leftarrow"], "twoheadleftarrow"], // <<-
  [["=", ">"], "Rightarrow"],
  [["\\equiv", ">"], "Longrightarrow"], // ==>
  [["\\le", ">"], "iff"],
  [["<", "="], "le"],
  [[">", "="], "ge"],
  [["!", "="], "neq"],
  [["=", "="], "equiv"],
  [["~", "="], "cong"],
  [["~", "~"], "approx"],
  [["+", "-"], "pm"],
  [[".", ".", "."], "ldots"],
];

export function structSpec(name, arity) {
  return STRUCTS[name] ?? { arity, layout: "generic", rows: [[...Array(arity).keys()]] };
}
