import { Plugin, TextSelection, NodeSelection } from "prosemirror-state";
import { Fragment } from "prosemirror-model";
import { schema } from "./schema.js";
import { inMath } from "./nav.js";
import { t } from "./i18n.js";
import { toCas, runCas } from "./cas.js";

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
  if (sel.empty || !inMath(sel.$from) || !sel.$from.sameParent(sel.$to)) return null;
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
  if (isFrac(node)) {
    const num = node.child(0).content, den = node.child(1).content;
    out.push({ id: "slash", tex: "a/b", label: t("notation.slash"), hint: true, replace: paren(num).append(Fragment.from(text("/"))).append(paren(den)) });
  }
  const at = slashAt(content);
  if (at >= 0) {
    const frac = struct("frac", unparen(content.cut(0, at)), unparen(content.cut(at + 1)));
    out.push({ id: "frac", tex: "\\frac{a}{b}", label: t("notation.frac"), hint: true, replace: Fragment.from(frac) });
  }
  if (node?.type === T.struct && node.attrs.name === "sqrt") {
    const half = T.sup.create(null, struct("frac", Fragment.from(text("1")), Fragment.from(text("2"))));
    out.push({ id: "power", tex: "x^{\\frac{1}{2}}", label: t("notation.power"), hint: true, replace: paren(node.child(0).content).append(Fragment.from(half)) });
  }
  // computed by Nerdamer when picked (the \ menu only)
  const input = toCas(content);
  if (input) for (const op of ["simplify", "factor", "expand"]) out.push({ id: op, tex: "", label: t(`notation.${op}`), input, op });
  if (isScript(node)) {
    out.push({ id: "unscript", tex: "x", label: t("notation.unscript"), replace: node.content });
  } else {
    out.push({ id: "sup", tex: "x^{\\square}", label: t("notation.sup"), replace: Fragment.from(T.sup.create(null, content)) });
    out.push({ id: "sub", tex: "x_{\\square}", label: t("notation.sub"), replace: Fragment.from(T.sub.create(null, content)) });
  }
  return out;
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
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// The hint: a row of chips under the selection, while it has actions.
export const notationHint = new Plugin({
  view(view) {
    const box = document.createElement("div");
    box.className = "notation-hint";
    box.hidden = true;
    document.body.append(box);
    let key = "";
    const update = () => {
      const actions = view.hasFocus() ? notationActions(view.state).filter((a) => a.hint) : [];
      if (!actions.length) { box.hidden = true; key = ""; return; }
      const { from, to } = view.state.selection;
      const k = `${from},${to},${actions.map((a) => a.id)}`;
      if (k === key) return;
      key = k;
      box.replaceChildren(
        Object.assign(document.createElement("span"), { className: "key", textContent: "\\" }),
        ...actions.map((a) => {
          const b = document.createElement("button");
          b.textContent = a.label;
          b.onmousedown = (ev) => { ev.preventDefault(); applyNotation(view, a); };
          return b;
        }),
      );
      box.hidden = false;
      const a = view.coordsAtPos(from), b = view.coordsAtPos(to);
      const bottom = Math.max(a.bottom, b.bottom) + 6;
      box.style.left = `${Math.min(a.left, b.left) + window.scrollX}px`;
      box.style.top = `${bottom + window.scrollY}px`;
    };
    view.dom.addEventListener("blur", update);
    view.dom.addEventListener("focus", update);
    return { update, destroy: () => box.remove() };
  },
});
