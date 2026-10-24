// Declarative tables. Adding a command = adding a row here.

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

export const SYMBOLS = {
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
  vee: sym("∨", "bin"), pm: sym("±", "bin"), setminus: sym("∖", "bin"),
  // relations
  le: sym("≤", "rel"), leq: sym("≤", "rel"), ge: sym("≥", "rel"), geq: sym("≥", "rel"),
  neq: sym("≠", "rel"), equiv: sym("≡", "rel"), cong: sym("≅", "rel"), simeq: sym("≃", "rel"),
  sim: sym("∼", "rel"), approx: sym("≈", "rel"), in: sym("∈", "rel"), notin: sym("∉", "rel"),
  subset: sym("⊂", "rel"), subseteq: sym("⊆", "rel"), supseteq: sym("⊇", "rel"),
  to: sym("→", "rel"), rightarrow: sym("→", "rel"), leftarrow: sym("←", "rel"),
  leftrightarrow: sym("↔", "rel"), mapsto: sym("↦", "rel"), Rightarrow: sym("⇒", "rel"), iff: sym("⟺", "rel"),
  hookrightarrow: sym("↪", "rel"), twoheadrightarrow: sym("↠", "rel"), vdash: sym("⊢", "rel"),
  // number systems
  N: bb("N"), Z: bb("Z"), Q: bb("Q"), R: bb("R"), C: bb("C"), F: bb("F"), P: bb("P"),
  // misc
  infty: sym("∞"), partial: sym("∂"), nabla: sym("∇"), forall: sym("∀"), exists: sym("∃"),
  ldots: sym("…"), cdots: sym("⋯"), emptyset: sym("∅"), ell: sym("ℓ", "ord", true), top: sym("⊤"), bot: sym("⊥"),
  // large operators
  sum: sym("∑", "op"), prod: sym("∏", "op"), int: sym("∫", "op"), coprod: sym("∐", "op"),
  // operator names; rank, Hom, End, Aut, id, im, coker, lcm, tr are not
  // LaTeX built-ins, so like \Z the publisher needs them defined (\operatorname)
  ...opnames("ker", "dim", "deg", "det", "rank", "hom", "Hom", "End", "Aut", "id", "im", "coker",
    "sin", "cos", "tan", "log", "ln", "exp", "lim", "sup", "inf", "max", "min", "arg", "gcd", "lcm", "mod", "Pr", "tr"),
  bigcup: sym("⋃", "op"), bigcap: sym("⋂", "op"), bigoplus: sym("⨁", "op"), bigotimes: sym("⨂", "op"),
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
};

// ASCII shorthands typed inside a formula, turned into a symbol as soon as
// they are complete. A sequence may continue a symbol made by a shorter one:
// "<=" is ≤ once "=" lands, and a following ">" makes it ⟺.
// Backspace right after a conversion gives back what was typed.
export const SHORTHANDS = [
  [["-", ">"], "to"],
  [["|", "\\to"], "mapsto"],
  [["<", "-"], "leftarrow"],
  [["\\leftarrow", ">"], "leftrightarrow"],
  [["=", ">"], "Rightarrow"],
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
