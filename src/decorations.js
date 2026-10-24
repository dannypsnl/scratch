import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { isMathContainer } from "./schema.js";
import { inMath } from "./nav.js";
import { X_ARROWS, ARROW_X, SYMBOLS } from "./specs.js";

// caret inside a code block or between two characters of inline code
// (always a boolean: classList.toggle(name, undefined) flips instead)
const isCode = (n) => !!n?.marks.some((m) => m.type.name === "code");
const inCode = ($p) => !!$p.parent.type.spec.code || $p.marks().some((m) => m.type.name === "code") || (isCode($p.nodeBefore) && isCode($p.nodeAfter));

// Glyph classes for plain characters typed into a formula. + - * are done
// below, with their neighbours (atomClasses).
const CHAR_CLASSES = [
  [/[0-9.]+/g, "pm-upright"],
  [/[=<>]/g, "pm-upright pm-rel"],
  [/[()[\]{}|!']/g, "pm-upright"],
  [/[,;]/g, "pm-upright pm-punct"],
];

// TeX's atoms, for spacing: a binary operator is spaced as one only between
// two things it can join; at the start, after an opening bracket, a comma, a
// relation, another operator or a large operator (-x, (-x), x = -y), or before
// a closing bracket, a comma or a relation, it is an ordinary symbol.
const CHAR_ATOM = { "+": "bin", "-": "bin", "*": "bin", "=": "rel", "<": "rel", ">": "rel", "(": "open", "[": "open", "{": "open", ")": "close", "]": "close", "}": "close", ",": "punct", ";": "punct" };
const SYM_ATOM = { rel: "rel", bin: "bin", op: "op", opname: "op", punct: "punct" };
function atomClasses(container, start, decos) {
  const atoms = []; // { kind, from, node }
  let pos = start;
  container.forEach((n) => {
    if (n.isText) for (const c of n.text) { atoms.push({ kind: CHAR_ATOM[c] ?? "ord", from: pos, char: c }); pos++; }
    else {
      // a script belongs to what it is on
      if (n.type.name !== "sup" && n.type.name !== "sub") atoms.push({ kind: n.type.name === "sym" ? SYM_ATOM[SYMBOLS[n.attrs.name]?.cls] ?? "ord" : "ord", from: pos, node: n });
      pos += n.nodeSize;
    }
  });
  atoms.forEach((a, k) => {
    if (a.kind !== "bin") return;
    const prev = atoms[k - 1]?.kind, next = atoms[k + 1]?.kind;
    const unary = !prev || ["bin", "rel", "open", "punct", "op"].includes(prev) || !next || ["rel", "close", "punct"].includes(next);
    const minus = a.char === "-" ? " pm-minus" : "";
    if (a.node) { if (unary) decos.push(Decoration.node(a.from, a.from + 1, { class: "pm-unary" })); }
    else decos.push(Decoration.inline(a.from, a.from + 1, { class: `pm-upright${unary ? "" : " pm-bin"}${minus}` }));
  });
}

// A label over (or under) a lone arrow: the arrow stretches to the label's
// width, as the \xrightarrow it is written as does (draw in specs.js); one over
// an \underset of an arrow lets that \underset take its whole width.
function arrowDraw(slot) {
  const n = slot.childCount === 1 ? slot.firstChild : null;
  return n?.type.name === "sym" ? X_ARROWS[ARROW_X[n.attrs.name]]?.draw ?? null : null;
}
function labelledArrow(node) {
  if (node.type.name !== "struct" || !["overset", "underset", "stackrel"].includes(node.attrs.name) || node.childCount !== 2) return null;
  const base = node.child(1), draw = arrowDraw(base);
  if (draw) return `pm-xarrow pm-xarrow-${draw}`;
  const under = base.childCount === 1 ? base.firstChild : null;
  if (node.attrs.name === "overset" && under?.type.name === "struct" && under.attrs.name === "underset" && under.childCount === 2 && arrowDraw(under.child(1))) return "pm-xarrow pm-xarrow-over";
  return null;
}

// CJK auto-spacing: a quarter-em gap where CJK meets Latin letters, digits
// or a formula, drawn as a margin (no space characters in the text). The gap
// sits on the right-hand item of each pair.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const LATIN = /[A-Za-z0-9]/;
const kind = (ch) => (CJK.test(ch) ? "cjk" : LATIN.test(ch) ? "latin" : null);
const gapBetween = (a, b) => a && b && a !== b && (a === "cjk" || b === "cjk");

function cjkSpacing(line, start, decos) {
  let prev = null; // "cjk" | "latin" | "math" | null
  let pos = start;
  line.forEach((child) => {
    if (child.isText) {
      for (const ch of child.text) {
        const k = kind(ch);
        if (gapBetween(prev, k)) decos.push(Decoration.inline(pos, pos + ch.length, { class: "cjk-gap" }));
        prev = k;
        pos += ch.length;
      }
      return;
    }
    const k = child.type.name === "math" ? "math" : null;
    if (k && gapBetween(prev, "math") && prev === "cjk") decos.push(Decoration.node(pos, pos + child.nodeSize, { class: "cjk-gap" }));
    prev = k;
    pos += child.nodeSize;
  });
}

// Web addresses in text are drawn as links (the text itself is unchanged,
// so they export as written); ⌘-click opens them (editor.js).
export const URL_RE = /https?:\/\/[^\s<>"'）」，。]+[^\s<>"'）」，。.,;:!?)\]]/g;

function webLinks(node, pos, decos) {
  for (const m of node.text.matchAll(URL_RE)) {
    decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, {
      nodeName: "a", class: "web-link", href: m[0], title: "⌘-click", "data-href": m[0],
    }));
  }
}

function staticDecos(doc) {
  const decos = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.name === "line") cjkSpacing(node, pos + 1, decos);
    if (node.isText && parent?.type.name === "line") webLinks(node, pos, decos);
    const xarrow = labelledArrow(node);
    if (xarrow) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: xarrow }));
    if (isMathContainer(node.type) && node.content.size === 0) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "pm-empty" }));
    }
    if (isMathContainer(node.type)) atomClasses(node, pos + 1, decos);
    if (node.isText && parent && isMathContainer(parent.type)) {
      for (const [re, cls] of CHAR_CLASSES) {
        for (const m of node.text.matchAll(re)) {
          decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, { class: cls }));
        }
      }
    }
  });
  return DecorationSet.create(doc, decos);
}

// The native caret is unreliable around formulas (nested inline spans, and
// WebKit snapping it into them), so the editor never shows it: one caret is
// drawn for every collapsed selection, the same everywhere. It floats above
// the page (absolutely positioned) instead of being a widget in the text: an
// extra element inside the line can leave WebKit nowhere to put the real
// caret, and then typing is refused. While an input method is composing,
// the drawn caret steps aside for the composition's own.
const wantsCaret = (view) => view.hasFocus() && view.state.selection.empty && !view.composing;

function fontSizeAt(view, pos) {
  let { node } = view.domAtPos(pos);
  if (node.nodeType !== 1) node = node.parentElement;
  return parseFloat(getComputedStyle(node).fontSize) || 16;
}

// sits on the line it is in, not raised or lowered like scripts and fractions
const onLevel = (n) => n && !["math", "struct", "sup", "sub"].includes(n.type.name);

function caretOverlay(view) {
  const el = document.createElement("div");
  el.className = "pm-caret";
  el.hidden = true;
  document.body.append(el);
  let last = "";
  const place = () => {
    if (view.isDestroyed) return;
    const show = wantsCaret(view);
    el.hidden = !show;
    if (!show) { last = ""; return; }
    // hidden tags (drawn at the row's end) have no place in the line: measure
    // from the visible content before them
    let at = view.state.selection.head;
    for (;;) {
      const n = view.state.doc.resolve(at).nodeBefore;
      if (!(n && n.type.name === "link" && n.attrs.tag)) break;
      at -= n.nodeSize;
    }
    const $h = view.state.doc.resolve(at);
    let c = view.coordsAtPos($h.pos, $h.nodeBefore ? -1 : 1);
    // beside a script, fraction or formula its box sits higher or lower than
    // the caret's own line: x from beside it, height from something on the
    // caret's level (the neighbour on the other side, else any in the container)
    if (!onLevel($h.nodeBefore) && $h.parent.inlineContent) {
      let ref = onLevel($h.nodeAfter) ? $h.pos : null;
      if (ref == null) $h.parent.forEach((n, off) => { if (ref == null && onLevel(n)) ref = $h.start() + off; });
      if (ref != null) {
        const r = view.coordsAtPos(ref, 1);
        if (r.top || r.bottom) c = { left: c.left, top: r.top, bottom: r.bottom };
      }
    }
    if (!c.top && !c.bottom) {
      // only hidden things around (a line that is just tags): its left edge
      const line = view.domAtPos($h.start()).node;
      const r = (line.nodeType === 1 ? line : line.parentElement).getBoundingClientRect();
      c = { left: r.left, top: r.top, bottom: r.top + r.height };
    }
    // WebKit can report nonsense for text in an absolutely positioned slot
    // (\overset's upper argument): keep the caret inside the box it is in
    if (inMath($h)) {
      let el = view.domAtPos($h.pos).node;
      if (el.nodeType !== 1) el = el.parentElement;
      const box = el.closest(".pm-slot, .pm-sup, .pm-sub, .pm-math")?.getBoundingClientRect();
      if (box && (c.left < box.left - 1 || c.left > box.right + 1 || c.bottom < box.top || c.top > box.bottom)) {
        c = { left: $h.parentOffset === 0 ? box.left : box.right, top: box.top, bottom: box.bottom };
      }
    }
    // height from the font size at the caret (smaller in scripts), centred
    // on the glyph box, so it does not jump with line heights or tall formulas
    const h = Math.round(fontSizeAt(view, $h.pos) * 1.15);
    const mid = (c.top + c.bottom) / 2;
    const key = `${c.left},${mid},${h}`;
    el.style.left = `${c.left + window.scrollX}px`;
    el.style.top = `${mid - h / 2 + window.scrollY}px`;
    el.style.height = `${h}px`;
    el.classList.toggle("in-math", inMath($h)); // formula mode at a glance
    el.classList.toggle("in-code", inCode($h));
    if (key !== last) { el.classList.remove("blink"); void el.offsetWidth; el.classList.add("blink"); }
    last = key;
  };
  // layout settles a frame later (script stacking), so place again then
  const update = () => { place(); requestAnimationFrame(place); };
  for (const ev of ["focus", "blur", "compositionstart", "compositionend"]) view.dom.addEventListener(ev, update);
  window.addEventListener("resize", update);
  update();
  return {
    update,
    destroy() {
      el.remove();
      window.removeEventListener("resize", update);
    },
  };
}

export const mathDecorations = new Plugin({
  state: {
    init: (_, state) => staticDecos(state.doc),
    apply: (tr, old) => (tr.docChanged ? staticDecos(tr.doc) : old),
  },
  view: caretOverlay,
  props: {
    decorations(state) {
      const set = this.getState(state);
      const $h = state.selection.$head;
      for (let d = $h.depth; d > 0; d--) {
        if ($h.node(d).type.name !== "math") continue;
        // the formula being edited gets a tint; the box the caret is in (a
        // slot, a script) a dashed frame, as TeXmacs does, so the end of a box
        // and the place just after it look different
        const decos = [Decoration.node($h.before(d), $h.after(d), { class: "pm-active" })];
        if ($h.depth > d) decos.push(Decoration.node($h.before(), $h.after(), { class: "pm-here" }));
        return set.add(state.doc, decos);
      }
      return set;
    },
  },
});
