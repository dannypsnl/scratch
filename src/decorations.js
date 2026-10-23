import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { isMathContainer } from "./schema.js";
import { inMath } from "./nav.js";

// caret inside a code block or between two characters of inline code
const isCode = (n) => n?.marks.some((m) => m.type.name === "code");
const inCode = ($p) => !!$p.parent.type.spec.code || $p.marks().some((m) => m.type.name === "code") || (isCode($p.nodeBefore) && isCode($p.nodeAfter));

// Glyph classes for plain characters typed into a formula.
const CHAR_CLASSES = [
  [/[0-9.]+/g, "pm-upright"],
  [/[+\-*]/g, "pm-upright pm-bin"],
  [/[=<>]/g, "pm-upright pm-rel"],
  [/[()[\]|!']/g, "pm-upright"],
  [/[,;]/g, "pm-upright pm-punct"],
];

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
    if (isMathContainer(node.type) && node.content.size === 0) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "pm-empty" }));
    }
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
        // highlight the formula being edited
        return set.add(state.doc, [Decoration.node($h.before(d), $h.after(d), { class: "pm-active" })]);
      }
      return set;
    },
  },
});
