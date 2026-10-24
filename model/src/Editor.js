// The editor (src/, JavaScript) as the fuzzer sees it: a line in the model's
// terms goes in, the editor's own commands run on a plain EditorState with
// the plugins that shape every transaction, and the line and selection come
// back out in the model's terms. Nothing is decided here; Fuzz.purs judges.
import { EditorState, TextSelection } from "prosemirror-state";
import { schema } from "../../../src/schema.js";
import { SYMBOLS, STRUCTS } from "../../../src/specs.js";
import { parseMath, serializeMath } from "../../../src/latex.js";
import { inMath, horizontal, vertical, term, selectTerm, selectStep, selectEdge, formula, backspace, deleteForward, typeInMath, insertStruct, navGuard, selectionShape } from "../../../src/nav.js";
import { notationActions } from "../../../src/notation.js";

const T = schema.nodes;

// ---- model line <-> document

function nodes(box) {
  const out = [];
  let text = "";
  const flush = () => { if (text) out.push(schema.text(text)); text = ""; };
  for (const it of box) {
    if (it.kind === "ch") { text += it.name; continue; }
    flush();
    const inner = (k) => nodes(it.slots[k]);
    if (it.kind === "sym") out.push(T.sym.create({ name: it.name }));
    else if (it.kind === "struct") out.push(T.struct.create({ name: it.name }, it.slots.map((_, k) => T.slot.create(null, inner(k)))));
    else out.push(T[it.kind].create(null, inner(0)));
  }
  flush();
  return out;
}
const toDoc = (line) => T.doc.create(null, T.block.create({ id: "b" }, T.line.create(null, nodes(line))));
function box(node) {
  const out = [];
  node.forEach((n) => {
    if (n.isText) for (const c of n.text) out.push({ kind: "ch", name: c, cls: "", slots: [] });
    else if (n.type === T.sym) out.push({ kind: "sym", name: n.attrs.name, cls: SYMBOLS[n.attrs.name]?.cls ?? "", slots: [] });
    else if (n.type === T.struct) { const slots = []; n.forEach((s) => slots.push(box(s))); out.push({ kind: "struct", name: n.attrs.name, cls: "", slots }); }
    else out.push({ kind: n.type.name, name: "", cls: "", slots: [box(n)] });
  });
  return out;
}
const size = (it) => (it.kind === "ch" || it.kind === "sym" ? 1 : 2 + it.slots.reduce((n, s) => n + (it.kind === "struct" ? 2 : 0) + boxSize(s), 0));
const boxSize = (b) => b.reduce((n, it) => n + size(it), 0);
function toPM(line, pos) {
  let at = 2, b = line;
  for (const step of pos.path) {
    at += boxSize(b.slice(0, step.item)) + 1;
    const it = b[step.item];
    if (it.kind === "struct") at += it.slots.slice(0, step.slot).reduce((n, s) => n + 2 + boxSize(s), 0) + 1;
    b = it.slots[step.slot];
  }
  return at + boxSize(b.slice(0, pos.off));
}
function fromPM(line, pm) {
  let found = null;
  const walk = (path, b) => {
    for (let off = 0; off <= b.length && !found; off++) if (toPM(line, { path, off }) === pm) found = { path, off };
    b.forEach((it, i) => it.slots.forEach((s, k) => found || walk([...path, { item: i, slot: k }], s)));
  };
  walk([], line);
  return found;
}

// ---- the editor's commands, by name

function typed(ch) {
  return (st, dispatch) => {
    if (!inMath(st.selection.$head)) { dispatch(st.tr.insertText(ch)); return true; }
    return typeInMath({ state: st, dispatch }, ch); // it wants a view: state and dispatch are all it uses
  };
}
const command = (name) => (st, dispatch) => inMath(st.selection.$head) && insertStruct(st, dispatch, name, STRUCTS[name]?.arity ?? 1);
const COMMANDS = {
  "right": horizontal(1), "left": horizontal(-1),
  "option-right": term(1), "option-left": term(-1),
  "option-shift-right": selectTerm(1), "option-shift-left": selectTerm(-1),
  "shift-right": selectStep(1), "shift-left": selectStep(-1),
  "shift-cmd-right": selectEdge(1), "shift-cmd-left": selectEdge(-1),
  "cmd-right": formula(1), "cmd-left": formula(-1),
  "down": vertical(1), "up": vertical(-1),
  "backspace": backspace, "delete": deleteForward,
  ...Object.fromEntries([..."ab1+=()^_/ ->|x"].map((c) => [`type ${c}`, typed(c)])),
  ...Object.fromEntries(["frac", "sqrt", "overset", "underset", "hat", "text", "xrightarrow", "binom", "mathbf"].map((n) => [`\\${n}`, command(n)])),
  "rewrite": (st, dispatch, pick) => {
    const acts = notationActions(st).filter((a) => a.replace);
    if (!acts.length) return false;
    const a = acts[Math.floor(pick * acts.length)];
    dispatch(st.tr.replaceWith(st.selection.from, st.selection.to, a.replace));
    return true;
  },
};

export const actionNames = Object.keys(COMMANDS);

// ---- what Fuzz.purs uses (curried, as PureScript calls)

export const start = (line) => (pos) => {
  const doc = toDoc(line);
  return EditorState.create({ doc, selection: TextSelection.create(doc, toPM(line, pos)), plugins: [navGuard, selectionShape] });
};

// { editor, error }: the state after the command (unchanged when it does
// not apply), or what it threw
export const act = (name) => (pick) => (st) => {
  try {
    let next = st;
    const dispatch = (tr) => { next = st.applyTransaction(tr).state; };
    // only the rewrite picks; the third argument of the others is a view (none here)
    if (name === "rewrite") COMMANDS[name](st, dispatch, pick); else COMMANDS[name](st, dispatch);
    return { editor: next, error: "" };
  } catch (e) {
    return { editor: st, error: `${name} threw: ${e.message}` };
  }
};

// the line, if the document is still one line (with a formula or not)
export const lineOf = (st) => box(st.doc.firstChild.firstChild);

// the selection in the model's terms; found is false for a place the model has no position for
export const selectionOf = (st) => {
  const line = lineOf(st);
  const anchor = fromPM(line, st.selection.anchor), head = fromPM(line, st.selection.head);
  return anchor && head ? { found: true, anchor, head } : { found: false, anchor: { path: [], off: 0 }, head: { path: [], off: 0 } };
};

// what only the editor can say: the document is valid, the selection is a
// text selection, and every formula survives its own LaTeX round trip ("" if so)
export const problems = (st) => {
  try { st.doc.check(); } catch (e) { return `invalid document: ${e.message}`; }
  if (st.doc.childCount !== 1 || st.doc.firstChild.childCount !== 1) return "the line became more than one block";
  let bad = "";
  st.doc.descendants((n) => {
    if (bad || n.type !== T.math) return !bad;
    const tex = serializeMath(n.content);
    const again = serializeMath(T.math.create(null, parseMath(tex)).content);
    if (again !== tex) bad = `LaTeX round trip: ${tex} -> ${again}`;
    return false;
  });
  return bad;
};

export const latexOf = (st) => {
  let tex = "";
  st.doc.descendants((n) => { if (n.type === T.math && !tex) tex = serializeMath(n.content); return !tex; });
  return tex;
};

export const env = (name) => (fallback) => process.env[name] ?? fallback;

export const exitWith = (code) => () => { process.exitCode = code; };
