// Typing in a formula: what keys typed on a formula (with a selection or a
// caret) make of it. Each case starts from LaTeX with a selection or caret
// marked in it, types its keys through the editor's own handler, and checks
// the LaTeX and what is selected afterwards.
//
//   [ ] a selection, | a caret (in the formula's top row)
import { EditorState, TextSelection } from "prosemirror-state";
import { schema } from "../src/schema.js";
import { parseMath, serializeMath } from "../src/latex.js";
import { typeInMath } from "../src/nav.js";

const T = schema.nodes;

const CASES = [
  // a bracket typed on a selection wraps it, which stays selected
  ["[a+b]", "(", "(a+b)", "a+b"],
  ["[a+b]", "((", "((a+b))", "a+b"],
  ["x+[y]", "[", "x+[y]", "y"],
  ["[x+y]", "|", "|x+y|", "x+y"],
  ["[x+y]", "{", "\\{x+y\\}", "x+y"],
  ["[\\frac{a}{b}]", "(", "(\\frac{a}{b})", "ab"],
  // with a caret it is just typed
  ["a|", "(", "a(", ""],
  // Unicode super- and subscripts, typed: scripts (a run of them, one script)
  ["x|", "²", "x^2", ""],
  ["x|", "²³", "x^{23}", ""],
  ["x|", "⁻¹", "x^{-1}", ""],
  ["x|", "₁₀", "x_{10}", ""],
  ["x|", "₁²", "x_1^2", ""],
];

// "[a+b]" -> its LaTeX without marks, and the marks' offsets in the
// formula's top row (the size of what the LaTeX before each makes)
function marked(src) {
  const tex = src.replace(/[[\]|]/g, "");
  const offset = (k) => T.math.create(null, parseMath(tex.slice(0, k))).content.size;
  if (src.includes("|")) return { tex, a: offset(src.indexOf("|")), b: offset(src.indexOf("|")) };
  return { tex, a: offset(src.indexOf("[")), b: offset(src.indexOf("]") - 1) };
}

const fails = [];
for (const [src, keys, want, wantSel] of CASES) {
  const { tex, a, b } = marked(src);
  const doc = T.doc.create(null, T.block.create({ id: "b" }, T.line.create(null, [T.math.create(null, parseMath(tex))])));
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 3 + a, 3 + b) }); // doc > block > line > math
  for (const k of keys) typeInMath({ state, dispatch: (tr) => { state = state.apply(tr); } }, k);
  const got = serializeMath(state.doc.firstChild.firstChild.firstChild.content);
  const sel = state.doc.textBetween(state.selection.from, state.selection.to, "", "□");
  if (got !== want || sel !== wantSel) fails.push(`${src} typed ${keys}: ${got} (selected ${JSON.stringify(sel)}), want ${want} (selected ${JSON.stringify(wantSel)})`);
}
for (const f of fails) console.log(f);
console.log(fails.length ? `${fails.length} of ${CASES.length} typing cases failed` : `${CASES.length} typing cases`);
process.exitCode = fails.length ? 1 : 0;
