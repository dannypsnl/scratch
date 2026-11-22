import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { isMathContainer } from "./schema.js";
import { inMath, mathDepth, codeLineStart } from "./nav.js";
import { X_ARROWS, ARROW_X, SYMBOLS, STRUCTS } from "./specs.js";
import { MATH_ITALIC } from "./katex-symbols.js";
import { inCode } from "./code.js";

const CHAR_CLASSES = [
  [/[0-9.]+/g, "pm-upright"],
  [/[=<>]/g, "pm-upright pm-rel"],
  [/[()[\]{}|!']/g, "pm-upright"],
  [/[,;]/g, "pm-upright pm-punct"],
];

const CHAR_ATOM = { "+": "bin", "-": "bin", "*": "bin", "=": "rel", "<": "rel", ">": "rel", "(": "open", "[": "open", "{": "open", ")": "close", "]": "close", "}": "close", ",": "punct", ";": "punct" };
const SYM_ATOM = { rel: "rel", bin: "bin", op: "op", opname: "op", punct: "punct" };
const BRACKET = { "(": "open", "[": "open", "{": "open", ")": "close", "]": "close", "}": "close" };
const UPRIGHT = /^(font-(?!normal$|bsym$)|opname$)/;
const italicCorrection = (from, to, c) => Decoration.inline(from, to, { style: `margin-right: ${MATH_ITALIC[c]}em` });
function atomClasses(container, start, decos, upright) {
  const atoms = [];
  const open = [];
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
      if (n.type.name !== "sup" && n.type.name !== "sub") {
        const kind = n.type.name === "sym" ? SYM_ATOM[SYMBOLS[n.attrs.name]?.cls] ?? "ord" : "ord";
        const asOp = kind === "bin" && beforeScript;
        const opname = n.type.name === "sym" ? SYMBOLS[n.attrs.name]?.cls === "opname" : STRUCTS[n.attrs.name]?.layout === "opname";
        atoms.push({ kind: asOp ? "op" : kind, asOp, opname, from: pos, node: n });
      }
      if (n.type.name === "sym") {
        const sym = SYMBOLS[n.attrs.name];
        bracket(sym?.char);
        if (sym?.italic && MATH_ITALIC[sym.char] && !beforeSub) decos.push(Decoration.node(pos, pos + n.nodeSize, { style: `margin-right: ${MATH_ITALIC[sym.char]}em` }));
      }
      pos += n.nodeSize;
    }
  });
  const unaryAt = (k) => {
    const prev = atoms[k - 1]?.kind, next = atoms[k + 1]?.kind;
    return !prev || ["bin", "rel", "open", "punct", "op"].includes(prev) || !next || ["rel", "close", "punct"].includes(next);
  };
  const spacingKind = (k) => atoms[k] && (atoms[k].kind === "bin" && unaryAt(k) ? "ord" : atoms[k].kind);
  atoms.forEach((a, k) => {
    if (a.opname) {
      const prev = spacingKind(k - 1), next = spacingKind(k + 1);
      const flush = [!prev || ["open", "rel", "bin"].includes(prev) ? "pm-flush-left" : "", !next || ["open", "close", "punct", "rel", "bin"].includes(next) ? "pm-flush-right" : ""].filter(Boolean).join(" ");
      if (flush) decos.push(Decoration.node(a.from, a.from + a.node.nodeSize, { class: flush }));
      return;
    }
    if (a.asOp) { decos.push(Decoration.node(a.from, a.from + 1, { class: "pm-unary pm-asop" })); return; }
    if (a.char && (a.kind === "open" || a.kind === "close")) decos.push(Decoration.inline(a.from, a.from + 1, { class: `pm-${a.kind}` }));
    if (a.char === ":") {
      const coloneq = atoms[k + 1]?.char === "=";
      decos.push(Decoration.inline(a.from, a.from + 1, { class: coloneq ? "pm-upright pm-rel pm-coloneq" : "pm-upright pm-rel" }));
      return;
    }
    if (a.kind !== "bin") return;
    const unary = unaryAt(k);
    const minus = a.char === "-" ? " pm-minus" : "";
    if (a.node) { if (unary) decos.push(Decoration.node(a.from, a.from + 1, { class: "pm-unary" })); }
    else decos.push(Decoration.inline(a.from, a.from + 1, { class: `pm-upright${unary ? "" : " pm-bin"}${minus}` }));
  });
}

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
  doc.descendants((node, pos) => {
    if (node.type.name !== "line") return true;
    lineDecos(node, pos + 1, decos);
    return false;
  });
  return DecorationSet.create(doc, decos);
}

function updateStaticDecos(set, tr) {
  const doc = tr.doc;
  set = set.map(tr.mapping, doc);
  const lines = new Map();
  tr.mapping.maps.forEach((map, i) => {
    const after = tr.mapping.slice(i + 1);
    map.forEach((_from, _to, from, to) => {
      const a = Math.max(0, after.map(from, -1) - 1), b = Math.min(doc.content.size, after.map(to, 1) + 1);
      doc.nodesBetween(a, b, (node, pos) => {
        if (node.type.name !== "line") return true;
        lines.set(pos, node);
        return false;
      });
    });
  });
  for (const [pos, line] of lines) {
    const decos = [];
    lineDecos(line, pos + 1, decos);
    set = set.remove(set.find(pos + 1, pos + line.nodeSize - 1)).add(doc, decos);
  }
  return set;
}

function lineDecos(line, start, decos) {
  cjkSpacing(line, start, decos);
  const uprightEnds = [];
  line.descendants((node, offset, parent) => {
    const pos = start + offset;
    while (uprightEnds.length && uprightEnds.at(-1) <= pos) uprightEnds.pop();
    if (node.type.name === "struct" && UPRIGHT.test(STRUCTS[node.attrs.name]?.layout ?? "")) uprightEnds.push(pos + node.nodeSize);
    if (node.isText && parent === line) webLinks(node, pos, decos);
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
}

const wantsCaret = (view) => view.hasFocus() && view.state.selection.empty && !view.composing;

function fontSizeAt(view, pos) {
  let { node } = view.domAtPos(pos);
  if (node.nodeType !== 1) node = node.parentElement;
  return parseFloat(getComputedStyle(node).fontSize) || 16;
}

const onLevel = (n) => n && !["math", "struct", "sup", "sub"].includes(n.type.name) && !(n.type.name === "sym" && SYMBOLS[n.attrs.name]?.cls === "op");

let caretEl = null, caretOwner = null, last = "";
function caretOverlay(view) {
  const place = () => {
    if (view.isDestroyed) return;
    if (!caretEl) caretEl = Object.assign(document.createElement("div"), { className: "pm-caret", hidden: true });
    if (!caretEl.isConnected) document.body.append(caretEl);
    const el = caretEl;
    const show = wantsCaret(view);
    if (!show) {
      if (caretOwner === view) { el.hidden = true; caretOwner = null; last = ""; }
      return;
    }
    caretOwner = view;
    el.hidden = false;
    const $h = view.state.selection.$head;
    const before = $h.nodeBefore;
    const atLineStart = before?.isText && before.text.endsWith("\n");
    let c = view.coordsAtPos($h.pos, before && !atLineStart ? -1 : 1);
    if (atLineStart) c = codeLineStart(view, $h.pos) ?? c;
    if (!onLevel($h.nodeBefore) && $h.parent.inlineContent) {
      const refs = [];
      const parent = $h.parent, start = $h.start(), index = $h.index();
      if (onLevel($h.nodeAfter)) refs.push([$h.pos, 1]);
      for (let i = index - 1, off = $h.parentOffset; i >= 0; i--) {
        const n = parent.child(i);
        if (onLevel(n)) { refs.push([start + off, -1]); break; }
        off -= n.nodeSize;
      }
      for (let i = index + 1, off = $h.parentOffset + ($h.nodeAfter?.nodeSize ?? 0); i < parent.childCount; i++) {
        const n = parent.child(i);
        if (onLevel(n)) { refs.push([start + off, 1]); break; }
        off += n.nodeSize;
      }
      const mid = (r) => (r.top + r.bottom) / 2;
      const onRow = (r) => (r.top || r.bottom) && (!(c.top || c.bottom) || Math.abs(mid(r) - mid(c)) < r.bottom - r.top);
      for (const [pos, side] of refs) {
        const r = view.coordsAtPos(pos, side);
        if (onRow(r)) { c = { left: c.left, top: r.top, bottom: r.bottom }; break; }
      }
    }
    const isCode = (n) => n?.marks.some((m) => m.type.name === "code");
    const end = isCode(before) && !isCode($h.nodeAfter), start = isCode($h.nodeAfter) && !isCode(before);
    if ((end || start) && !inCode(view.state)) {
      let box = view.domAtPos($h.pos + (end ? -1 : 1)).node;
      if (box.nodeType !== 1) box = box.parentElement;
      const rects = box.closest(".pm-icode")?.getClientRects();
      const r = rects?.length && rects[end ? rects.length - 1 : 0];
      if (r) c = { left: end ? r.right : r.left, top: c.top, bottom: c.bottom };
    } else if (start) c = view.coordsAtPos($h.pos, 1);
    if (!c.top && !c.bottom) {
      const line = view.domAtPos($h.start()).node;
      const r = (line.nodeType === 1 ? line : line.parentElement).getBoundingClientRect();
      c = { left: r.left, top: r.top, bottom: r.top + r.height };
    }
    if (inMath($h)) {
      let el = view.domAtPos($h.pos).node;
      if (el.nodeType !== 1) el = el.parentElement;
      const box = el.closest(".pm-slot, .pm-sup, .pm-sub, .pm-math")?.getBoundingClientRect();
      if (box && (c.left < box.left - 1 || c.left > box.right + 1 || c.bottom < box.top || c.top > box.bottom)) {
        c = { left: $h.parentOffset === 0 ? box.left : box.right, top: box.top, bottom: box.bottom };
      }
    }
    const h = Math.round(fontSizeAt(view, $h.pos) * 1.15);
    const mid = (c.top + c.bottom) / 2;
    const key = `${c.left},${mid},${h}`;
    el.style.left = `${c.left + window.scrollX}px`;
    el.style.top = `${mid - h / 2 + window.scrollY}px`;
    el.style.height = `${h}px`;
    el.classList.toggle("in-math", inMath($h));
    el.classList.toggle("in-code", inCode(view.state));
    if (key !== last) {
      el.classList.add("blink");
      for (const a of el.getAnimations?.() ?? []) a.currentTime = 0;
    }
    last = key;
  };
  let frame = 0;
  const update = () => {
    place();
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); });
  };
  for (const ev of ["focus", "blur", "compositionstart", "compositionend"]) view.dom.addEventListener(ev, update);
  caretUpdates.set(view, update);
  update();
  return {
    update,
    destroy() {
      cancelAnimationFrame(frame);
      if (caretOwner === view) { caretEl.hidden = true; caretOwner = null; last = ""; }
    },
  };
}
const caretUpdates = new WeakMap();
if (typeof window !== "undefined") window.addEventListener("resize", () => { if (caretOwner) caretUpdates.get(caretOwner)?.(); });

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

const lineStart = new WeakMap();

export const mathDecorations = new Plugin({
  state: {
    init: (_, state) => ({ set: staticDecos(state.doc), shut: DecorationSet.create(state.doc, shutDecos(state)), composing: false }),
    apply: (tr, old, _, state) => {
      const composing = tr.getMeta(mathDecorations) === "composed" ? false : old.composing || !!tr.getMeta("composition");
      return {
        set: tr.docChanged ? updateStaticDecos(old.set, tr) : old.set,
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
      const decos = [Decoration.node($h.before(d), $h.after(d), { class: "pm-active" })];
      if ($h.depth > d && $h.parent.content.size) decos.push(Decoration.node($h.before(), $h.after(), { class: "pm-here" }));
      return set.add(state.doc, [...decos, ...selected(state), ...shut.find()]);
    },
  },
});
