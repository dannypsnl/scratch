import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { isMathContainer } from "./schema.js";
import { inMath, mathDepth } from "./nav.js";
import { X_ARROWS, ARROW_X, SYMBOLS, STRUCTS } from "./specs.js";
import { MATH_ITALIC } from "./katex-symbols.js";
import { inCode } from "./code.js";

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
// a closing bracket, a comma or a relation, it is an ordinary symbol. One
// with a script on it is used as a large operator (\sqcup_y, a coproduct):
// spaced as \sum_y is, nothing beside it and a thin space after the script.
// A bar | closes the bar before it when one is open and it does not come
// right after an opening bracket (||x||), and opens one otherwise: |-|
// and |x| are bracketed, as (x) is. Brackets are classed pm-open /
// pm-close for the spacing beside them (style.css).
// A colon is a relation, spaced evenly on both sides as = is (TeX's bare :):
// the typing colon x : A, the bar of a set builder {x : x > 0}; := is one
// relation (\coloneqq).
// A math italic letter gets its italic correction after it, as TeX and
// KaTeX give it (MATH_ITALIC, from KaTeX's font metrics): a ) or a : after
// a P or an f clears the letter's overhang. Not before a subscript, which
// sits under the overhang, and not in a structure that sets its text
// upright (\mathrm, \text, \operatorname, …: UPRIGHT).
const CHAR_ATOM = { "+": "bin", "-": "bin", "*": "bin", "=": "rel", "<": "rel", ">": "rel", "(": "open", "[": "open", "{": "open", ")": "close", "]": "close", "}": "close", ",": "punct", ";": "punct" };
const SYM_ATOM = { rel: "rel", bin: "bin", op: "op", opname: "op", punct: "punct" };
const BRACKET = { "(": "open", "[": "open", "{": "open", ")": "close", "]": "close", "}": "close" };
const UPRIGHT = /^(font-(?!normal$|bsym$)|opname$)/;
const italicCorrection = (from, to, c) => Decoration.inline(from, to, { style: `margin-right: ${MATH_ITALIC[c]}em` });
function atomClasses(container, start, decos, upright) {
  const atoms = []; // { kind, from, node }
  const open = []; // the unclosed brackets so far, as their characters
  let pos = start;
  const bracket = (c) => { if (BRACKET[c] === "open") open.push(c); else if (BRACKET[c] === "close") open.pop(); };
  container.forEach((n, _, index) => {
    const nextName = container.maybeChild(index + 1)?.type.name;
    const beforeSub = nextName === "sub", beforeScript = beforeSub || nextName === "sup";
    if (n.isText) [...n.text].forEach((c, i, chars) => {
      const kind = c === ":" ? "rel"
        : c === "|" ? (open.at(-1) === "|" && atoms.at(-1)?.kind !== "open" ? "close" : "open")
        : CHAR_ATOM[c] ?? "ord";
      atoms.push({ kind, from: pos, char: c });
      if (c === "|") { if (kind === "open") open.push(c); else open.pop(); } else bracket(c);
      if (!upright && MATH_ITALIC[c] && !(beforeSub && i === chars.length - 1)) decos.push(italicCorrection(pos, pos + 1, c));
      pos++;
    });
    else {
      // a script belongs to what it is on
      if (n.type.name !== "sup" && n.type.name !== "sub") {
        const kind = n.type.name === "sym" ? SYM_ATOM[SYMBOLS[n.attrs.name]?.cls] ?? "ord" : "ord";
        const asOp = kind === "bin" && beforeScript;
        atoms.push({ kind: asOp ? "op" : kind, asOp, from: pos, node: n });
      }
      if (n.type.name === "sym") {
        const sym = SYMBOLS[n.attrs.name];
        bracket(sym?.char); // \{ \}
        if (sym?.italic && MATH_ITALIC[sym.char] && !beforeSub) decos.push(Decoration.node(pos, pos + n.nodeSize, { style: `margin-right: ${MATH_ITALIC[sym.char]}em` }));
      }
      pos += n.nodeSize;
    }
  });
  atoms.forEach((a, k) => {
    if (a.asOp) { decos.push(Decoration.node(a.from, a.from + 1, { class: "pm-unary pm-asop" })); return; }
    if (a.char && (a.kind === "open" || a.kind === "close")) decos.push(Decoration.inline(a.from, a.from + 1, { class: `pm-${a.kind}` }));
    if (a.char === ":") {
      const coloneq = atoms[k + 1]?.char === "=";
      decos.push(Decoration.inline(a.from, a.from + 1, { class: coloneq ? "pm-upright pm-rel pm-coloneq" : "pm-upright pm-rel" }));
      return;
    }
    if (a.kind !== "bin") return;
    const prev = atoms[k - 1]?.kind, next = atoms[k + 1]?.kind;
    const unary = !prev || ["bin", "rel", "open", "punct", "op"].includes(prev) || !next || ["rel", "close", "punct"].includes(next);
    const minus = a.char === "-" ? " pm-minus" : "";
    if (a.node) { if (unary) decos.push(Decoration.node(a.from, a.from + 1, { class: "pm-unary" })); }
    else decos.push(Decoration.inline(a.from, a.from + 1, { class: `pm-upright${unary ? "" : " pm-bin"}${minus}` }));
  });
}

// A label over (or under) a lone arrow: the arrow is drawn stretched to the
// label with KaTeX's own shape for the \xrightarrow it is written as
// (katex-stretchy.css); one over an \underset of an arrow lets that
// \underset take its whole width.
function xArrowOf(slot) {
  const n = slot.childCount === 1 ? slot.firstChild : null;
  return n?.type.name === "sym" && ARROW_X[n.attrs.name] ? ARROW_X[n.attrs.name] : null;
}
function labelledArrow(node) {
  if (node.type.name !== "struct" || !["overset", "underset", "stackrel"].includes(node.attrs.name) || node.childCount !== 2) return null;
  const x = xArrowOf(node.child(1));
  if (x) return `pm-xarrow pm-st-${x}`;
  const under = node.child(1).childCount === 1 ? node.child(1).firstChild : null;
  if (node.attrs.name === "overset" && under?.type.name === "struct" && under.attrs.name === "underset" && under.childCount === 2 && xArrowOf(under.child(1))) return "pm-xarrow-over";
  return null;
}

// CJK auto-spacing: a quarter-em gap where CJK meets Latin letters, digits,
// a formula or inline code, drawn as a margin (no space characters in the
// text). The gap sits on the right-hand item of each pair. Inline code is
// one item, as a formula is (its text is as written, with no gaps inside),
// and a gap before it goes on its box (style.css).
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const LATIN = /[A-Za-z0-9]/;
const kind = (ch) => (CJK.test(ch) ? "cjk" : LATIN.test(ch) ? "latin" : null);
const gapBetween = (a, b) => a && b && a !== b && (a === "cjk" || b === "cjk");

function cjkSpacing(line, start, decos) {
  let prev = null; // "cjk" | "latin" | "math" | "code" | null
  let pos = start;
  line.forEach((child) => {
    if (child.isText && child.marks.some((m) => m.type.name === "code")) {
      if (prev === "cjk") decos.push(Decoration.inline(pos, pos + child.nodeSize, { class: "cjk-gap" }));
      prev = "code";
      pos += child.nodeSize;
      return;
    }
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
  const uprightEnds = []; // where the structures setting their text upright end (innermost last)
  doc.descendants((node, pos, parent) => {
    while (uprightEnds.length && uprightEnds.at(-1) <= pos) uprightEnds.pop();
    if (node.type.name === "struct" && UPRIGHT.test(STRUCTS[node.attrs.name]?.layout ?? "")) uprightEnds.push(pos + node.nodeSize);
    if (node.type.name === "line") cjkSpacing(node, pos + 1, decos);
    if (node.isText && parent?.type.name === "line") webLinks(node, pos, decos);
    const xarrow = labelledArrow(node);
    if (xarrow) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: xarrow }));
    if (isMathContainer(node.type) && node.content.size === 0) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "pm-empty" }));
    }
    if (isMathContainer(node.type)) atomClasses(node, pos + 1, decos, uprightEnds.length > 0);
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
// (a large operator is drawn larger and lower: not on the caret's level)
const onLevel = (n) => n && !["math", "struct", "sup", "sub"].includes(n.type.name) && !(n.type.name === "sym" && SYMBOLS[n.attrs.name]?.cls === "op");

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
    const $h = view.state.selection.$head;
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
      // nothing measurable around: the line's left edge
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
    el.classList.toggle("in-code", inCode(view.state));
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

// The place just outside a formula and the formula's own edge are one place
// to the DOM, and an input method composes at whichever the browser picks
// (注音 typed after $m_2$ went into the subscript). So for a caret at either,
// the other side is shut to the browser (contenteditable false) while it is
// there: the formula, for a caret in text beside it; the neighbour outside,
// for a caret at the formula's edge within.
function shutDecos(state) {
  const { $head: $h, empty } = state.selection;
  if (!empty) return [];
  const shut = (from, to) => {
    const $f = state.doc.resolve(from);
    if (from === to || $f.parent !== state.doc.resolve(to).parent) return [];
    return [$f.nodeAfter?.isText ? Decoration.inline(from, to, { contenteditable: "false" }) : Decoration.node(from, to, { contenteditable: "false" })];
  };
  const d = mathDepth($h);
  if (d < 0) {
    return [
      ...($h.nodeBefore?.type.name === "math" ? shut($h.pos - $h.nodeBefore.nodeSize, $h.pos) : []),
      ...($h.nodeAfter?.type.name === "math" ? shut($h.pos, $h.pos + $h.nodeAfter.nodeSize) : []),
    ];
  }
  let atStart = $h.parentOffset === 0, atEnd = $h.parentOffset === $h.parent.content.size;
  for (let k = d; k < $h.depth; k++) {
    atStart &&= $h.index(k) === 0;
    atEnd &&= $h.indexAfter(k) === $h.node(k).childCount;
  }
  const $m = state.doc.resolve($h.before(d)), $e = state.doc.resolve($h.after(d));
  return [
    ...(atStart && $m.nodeBefore ? shut($m.pos - ($m.nodeBefore.isText ? 1 : $m.nodeBefore.nodeSize), $m.pos) : []),
    ...(atEnd && $e.nodeAfter ? shut($e.pos, $e.pos + ($e.nodeAfter.isText ? 1 : $e.nodeAfter.nodeSize)) : []),
  ];
}

// What is selected in a formula is marked by the editor, a whole structure,
// symbol or script at a time: the browser's own highlight paints text only,
// and leaves out what is drawn (growing parentheses, a fraction's bar, a
// root's sign) and, next to such things, sometimes the text as well.
function selected(state) {
  const { $from, $to, empty } = state.selection;
  if (empty || !$from.sameParent($to) || !isMathContainer($from.parent.type)) return [];
  const out = [];
  let pos = $from.start();
  $from.parent.forEach((c) => {
    if (!c.isText && pos >= $from.pos && pos + c.nodeSize <= $to.pos) out.push(Decoration.node(pos, pos + c.nodeSize, { class: "pm-selected" }));
    pos += c.nodeSize;
  });
  return out;
}

// where a composition began, when that was the start of a line before a formula
const lineStart = new WeakMap();

export const mathDecorations = new Plugin({
  state: {
    init: (_, state) => ({ set: staticDecos(state.doc), shut: DecorationSet.create(state.doc, shutDecos(state)), composing: false }),
    apply: (tr, old, _, state) => {
      // while an input method composes (from its first change until a while
      // after it ends: WebKit commits by deleting the composition and then
      // inserting the result), what is shut stays shut: the caret moves
      // with the composition, and opening the formula beside it lets the
      // commit land inside
      const composing = tr.getMeta(mathDecorations) === "composed" ? false : old.composing || !!tr.getMeta("composition");
      return {
        set: tr.docChanged ? staticDecos(tr.doc) : old.set,
        shut: composing ? old.shut.map(tr.mapping, tr.doc) : DecorationSet.create(state.doc, shutDecos(state)),
        composing,
      };
    },
  },
  view: caretOverlay,
  props: {
    handleDOMEvents: {
      compositionstart(view) {
        const { $head, empty } = view.state.selection;
        lineStart.set(view, empty && $head.parentOffset === 0 && $head.nodeAfter?.type.name === "math" ? $head.pos : null);
        return false;
      },
      compositionend(view, ev) {
        setTimeout(() => {
          if (view.composing || view.isDestroyed) return;
          const tr = view.state.tr.setMeta(mathDecorations, "composed");
          // composing at the start of a line, before a formula that starts
          // with a structure, WebKit leaves a placeholder space after what it
          // commits: it goes
          const at = lineStart.get(view), word = ev.data ?? "";
          const $p = at == null ? null : tr.doc.resolve(at);
          const text = $p?.nodeAfter, next = $p?.parent.maybeChild($p.index() + 1);
          if (text?.isText && next?.type.name === "math" && (text.text === `${word} ` || text.text === `${word}\u00a0`)) tr.delete(at + word.length, at + word.length + 1);
          view.dispatch(tr);
        }, 50);
        return false;
      },
    },
    decorations(state) {
      const { set, shut } = this.getState(state);
      const $h = state.selection.$head;
      const d = mathDepth($h);
      if (d < 0) return set.add(state.doc, shut.find());
      // the formula being edited gets a tint; the box the caret is in (a
      // slot, a script) a dashed frame, as TeXmacs does, so the end of a box
      // and the place just after it look different
      const decos = [Decoration.node($h.before(d), $h.after(d), { class: "pm-active" })];
      // (an empty box shows itself already, as a dashed placeholder)
      if ($h.depth > d && $h.parent.content.size) decos.push(Decoration.node($h.before(), $h.after(), { class: "pm-here" }));
      return set.add(state.doc, [...decos, ...selected(state), ...shut.find()]);
    },
  },
});
