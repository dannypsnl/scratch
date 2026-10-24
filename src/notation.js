import { Plugin, TextSelection, NodeSelection } from "prosemirror-state";
import { Fragment } from "prosemirror-model";
import { schema, isMathContainer } from "./schema.js";
import { SYMBOLS } from "./specs.js";
import { t } from "./i18n.js";
import { toCas, runCas, casAnswer } from "./cas.js";
import { inText } from "./nav.js";
import { openPalette } from "./palette.js";
import { serializeMath } from "./latex.js";
import katex from "katex";

const T = schema.nodes;

// Other ways to write what is selected in a formula: a stacked fraction or
// a/b, √x or x^{1/2}, or the selection moved into a superscript / subscript.
// "\" puts them all first in its menu; a hint under the selection shows only
// the real notation changes (`hint`), so selecting a plain letter shows nothing.

const text = (s) => schema.text(s);
const struct = (name, ...slots) => T.struct.create({ name }, slots.map((c) => T.slot.create(null, c)));

// one token (a letter, a number, a symbol or a structure) needs no parentheses
// beside "/" or under a power; anything longer does
function atomic(frag) {
  if (frag.childCount !== 1) return frag.childCount === 0;
  const n = frag.firstChild;
  return !n.isText || /^([A-Za-z]|[0-9.]+)$/.test(n.text);
}
const paren = (frag) => (atomic(frag) ? frag : Fragment.from(text("(")).append(frag).append(Fragment.from(text(")"))));

// Offset of the first "/" outside parentheses, or -1.
function slashAt(frag) {
  let depth = 0, pos = 0, found = -1;
  frag.forEach((n) => {
    if (found < 0 && n.isText) {
      for (let k = 0; k < n.text.length && found < 0; k++) {
        const ch = n.text[k];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === "/" && depth === 0) found = pos + k;
      }
    }
    pos += n.nodeSize;
  });
  return found;
}

// every ")" closes a "(" before it, and every "(" is closed
function balanced(frag) {
  let depth = 0, ok = true;
  frag.forEach((n) => {
    if (n.isText) for (const c of n.text) { if (c === "(") depth++; else if (c === ")" && --depth < 0) ok = false; }
  });
  return ok && depth === 0;
}

// (a+b) -> a+b, when the outer parentheses enclose all of it
function unparen(frag) {
  const s = frag.size;
  if (s < 2 || !frag.firstChild.isText || !frag.lastChild.isText) return frag;
  if (!frag.firstChild.text.startsWith("(") || !frag.lastChild.text.endsWith(")")) return frag;
  let depth = 0, pos = 0, closesEarly = false;
  frag.forEach((n) => {
    if (n.isText) for (let k = 0; k < n.text.length; k++) {
      if (n.text[k] === "(") depth++;
      else if (n.text[k] === ")" && --depth === 0 && pos + k < s - 1) closesEarly = true;
    }
    pos += n.nodeSize;
  });
  return closesEarly ? frag : frag.cut(1, s - 1);
}

// The selection, when it lies within one container of a formula.
function selected(state) {
  const sel = state.selection;
  // within one container (a slot itself, node-selected, is not a selection here)
  if (sel.empty || !isMathContainer(sel.$from.parent.type) || !sel.$from.sameParent(sel.$to) || inText(sel.$from)) return null;
  const content = state.doc.slice(sel.from, sel.to).content;
  const node = sel instanceof NodeSelection ? sel.node : content.childCount === 1 && !content.firstChild.isText ? content.firstChild : null;
  return { from: sel.from, to: sel.to, content, node };
}

const isFrac = (n) => n?.type === T.struct && (n.attrs.name === "frac" || n.attrs.name === "dfrac");
const isScript = (n) => n?.type === T.sup || n?.type === T.sub;

// [{ id, tex, label, replace }]: replace is the content put in place of the selection
export function notationActions(state) {
  const s = selected(state);
  if (!s) return [];
  const { content, node } = s;
  const out = [];
  // a/b only when both sides' parentheses pair up: otherwise the ones added
  // around a side could not be told apart on the way back
  if (isFrac(node) && balanced(node.child(0).content) && balanced(node.child(1).content)) {
    const num = node.child(0).content, den = node.child(1).content;
    out.push({ id: "slash", tex: "a/b", label: t("notation.slash"), replace: paren(num).append(Fragment.from(text("/"))).append(paren(den)) });
  }
  const at = slashAt(content);
  if (at >= 0) {
    const frac = struct("frac", unparen(content.cut(0, at)), unparen(content.cut(at + 1)));
    out.push({ id: "frac", tex: "\\frac{a}{b}", label: t("notation.frac"), replace: Fragment.from(frac) });
  }
  if (node?.type === T.struct && node.attrs.name === "sqrt") {
    const half = T.sup.create(null, struct("frac", Fragment.from(text("1")), Fragment.from(text("2"))));
    out.push({ id: "power", tex: "x^{\\frac{1}{2}}", label: t("notation.power"), replace: paren(node.child(0).content).append(Fragment.from(half)) });
  }
  // computed by Nerdamer (offered once worked out, when the answer changes
  // something: selectionActions)
  const input = toCas(content);
  if (input) for (const op of ["simplify", "factor", "expand"]) out.push({ id: op, tex: "", label: t(`notation.${op}`), input, op });
  if (isScript(node)) {
    out.push({ id: "unscript", tex: "x", label: t("notation.unscript"), replace: node.content });
  } else {
    out.push({ id: "sup", key: "^", tex: "x^{\\square}", label: t("notation.sup"), replace: Fragment.from(T.sup.create(null, content)) });
    out.push({ id: "sub", key: "_", tex: "x_{\\square}", label: t("notation.sub"), replace: Fragment.from(T.sub.create(null, content)) });
  }
  return out;
}

// What Nerdamer makes of a selection, worked out as soon as it is selected
// (op and input -> the answer's content when it changes something, else
// null, also while it is still being worked out), so that the hint offers
// only the actions that do something.
const answers = new Map();
let working = 0, settled = [];
function answer(op, input) {
  const key = `${op} ${input}`;
  if (!answers.has(key)) {
    if (answers.size > 500) answers.clear();
    answers.set(key, null);
    working++;
    casAnswer(op, input)
      .then((r) => { if (r?.changed) answers.set(key, Fragment.from(r.nodes)); }, () => {})
      .finally(() => {
        if (--working === 0) for (const f of settled.splice(0)) f();
        drawHint();
      });
  }
  return answers.get(key);
}
// (for tests: once every answer asked for is in)
export const casSettled = () => (working ? new Promise((f) => settled.push(f)) : Promise.resolve());

// What a selection offers, in the menu Space (or the hint's button) opens:
// every action, the Nerdamer ones once their answer is known to be another
// expression.
export function selectionActions(state) {
  return notationActions(state).flatMap((a) => {
    if (!a.op) return [a];
    const r = answer(a.op, a.input);
    return r ? [{ ...a, op: null, replace: r, tex: serializeMath(r) }] : []; // shown with its answer
  });
}


// Replace the selection; what replaced it stays selected, so the hint offers
// the way back. A Nerdamer action replaces it once the answer is in, unless
// the formula changed meanwhile.
export async function applyNotation(view, action) {
  let replace = action.replace;
  if (action.op) {
    const doc = view.state.doc;
    const nodes = await runCas(action.op, action.input);
    if (!nodes || view.state.doc !== doc) return;
    replace = Fragment.from(nodes);
  }
  const { from, to } = view.state.selection;
  const tr = view.state.tr.replaceWith(from, to, replace);
  tr.setSelection(TextSelection.create(tr.doc, from, from + replace.size));
  view.dispatch(tr.setMeta("notTyped", true).scrollIntoView());
  view.focus();
}

// After an "=" just typed (the caret right after it, spaces allowed): what
// the left side comes to, from the relation before it (or the start of the
// line of the formula) to the "=". Offered when it is an algebraic
// expression and an answer differs from it as written; picked, the answer
// goes after the "=".
function equalsAt(state) {
  const sel = state.selection;
  if (!sel.empty || !isMathContainer(sel.$from.parent.type) || inText(sel.$from)) return null;
  const before = sel.$from.parent.content.cut(0, sel.$from.parentOffset);
  const last = before.lastChild;
  const m = last?.isText && /=\s*$/.exec(last.text);
  if (!m) return null;
  const end = before.size - (last.text.length - m.index);
  let start = 0, pos = 0;
  before.forEach((n) => {
    if (n.isText) for (let k = 0; k < n.text.length; k++) if (pos + k < end && "=<>".includes(n.text[k])) start = pos + k + 1;
    pos += n.nodeSize;
  });
  // nothing before the "=" on a line that goes on from the step above it
  // (chain.js): what that step came to, after its last relation
  const input = end === 0 && start === 0 ? stepAbove(sel.$from) : toCas(before.cut(start, end));
  // h(x) may be a function applied, which Nerdamer takes for h times x:
  // offered unasked, an answer must not rest on that guess
  if (!input || /[A-Za-z_0-9]\*\(/.test(input)) return null;
  return { input, at: sel.from, space: !/\s$/.test(last.text) };
}

// The formula of the line above (a sibling block), from its last relation
// on, as Nerdamer input, when the caret's formula starts its line.
function stepAbove($p) {
  const d = $p.depth; // $p.parent: the formula
  if ($p.node(d).type !== T.math || $p.index(d - 1) !== 0 || d < 3) return null;
  const idx = $p.index(d - 3);
  const prev = idx > 0 ? $p.node(d - 3).child(idx - 1) : null;
  const math = prev?.type === T.block && prev.firstChild.firstChild?.type === T.math ? prev.firstChild.firstChild : null;
  if (!math) return null;
  let from = 0, pos = 0;
  math.forEach((n) => {
    if (n.isText) { for (let k = 0; k < n.text.length; k++) if ("=<>".includes(n.text[k])) from = pos + k + 1; }
    else if (n.type === T.sym && SYMBOLS[n.attrs.name]?.cls === "rel") from = pos + n.nodeSize;
    pos += n.nodeSize;
  });
  return from > 0 ? toCas(math.content.cut(from)) : null;
}

// [{ op, label, tex, replace }]: one per different answer
export function equalsActions(state) {
  const e = equalsAt(state);
  if (!e) return [];
  const seen = new Set();
  return ["expand", "factor", "simplify"].flatMap((op) => {
    const r = answer(op, e.input);
    if (!r) return [];
    const tex = serializeMath(r);
    if (seen.has(tex)) return [];
    seen.add(tex);
    return [{ op, label: t(`notation.${op}`), tex, replace: r, at: e.at, space: e.space }];
  });
}

export function applyEquals(view, action) {
  const pre = action.space ? Fragment.from(text(" ")) : Fragment.empty;
  const tr = view.state.tr.insert(action.at, pre.append(action.replace));
  tr.setSelection(TextSelection.create(tr.doc, action.at + pre.size + action.replace.size));
  view.dispatch(tr.setMeta("notTyped", true).scrollIntoView());
  view.focus();
}

// The hint: under a selection within a formula, one button for the whole
// app that opens the menu of what can be done with it (as Space does), so
// that the menu is found by looking. A function of the focused editor alone:
// every editor update and every focus change draws it again from scratch, so
// an editor that lost focus, or was taken out of the page without being
// destroyed, leaves nothing behind.
const editors = new Set();
let box = null;

function drawHint() {
  box ??= Object.assign(document.createElement("div"), { className: "notation-hint", hidden: true });
  if (!box.isConnected) document.body.append(box);
  const view = [...editors].find((v) => v.dom.isConnected && v.hasFocus());
  const actions = view ? selectionActions(view.state) : [];
  const equals = view && !actions.length ? equalsActions(view.state) : [];
  box.hidden = !actions.length && !equals.length;
  if (box.hidden) return;
  if (equals.length) {
    box.replaceChildren(...equals.map((a) => {
      const b = document.createElement("button");
      b.className = "equals";
      // the answer alone: a label (expand, factor) was as often wrong as right
      b.innerHTML = katex.renderToString(a.tex, { throwOnError: false });
      b.onmousedown = (ev) => { ev.preventDefault(); applyEquals(view, a); };
      return b;
    }));
    const c = view.coordsAtPos(view.state.selection.from);
    box.style.left = `${c.left + window.scrollX}px`;
    box.style.top = `${c.bottom + 6 + window.scrollY}px`;
    return;
  }
  const button = document.createElement("button");
  button.append(t("notation.menu"), Object.assign(document.createElement("span"), { className: "key", textContent: "␣" }));
  button.onmousedown = (ev) => { ev.preventDefault(); openPalette(view, "", { actionsOnly: true }); };
  box.replaceChildren(button);
  const { from, to } = view.state.selection;
  const a = view.coordsAtPos(from), b = view.coordsAtPos(to);
  box.style.left = `${Math.min(a.left, b.left) + window.scrollX}px`;
  box.style.top = `${Math.max(a.bottom, b.bottom) + 6 + window.scrollY}px`;
}
let listening = false;

export const notationHint = new Plugin({
  view(view) {
    if (!listening) {
      listening = true;
      document.addEventListener("focusin", () => queueMicrotask(drawHint));
      document.addEventListener("focusout", () => queueMicrotask(drawHint));
    }
    editors.add(view);
    drawHint();
    return { update: drawHint, destroy: () => { editors.delete(view); drawHint(); } };
  },
});
