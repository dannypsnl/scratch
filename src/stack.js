import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { LIMITS, SYMBOLS } from "./specs.js";

// A sub directly followed by a sup (or the reverse) is drawn as one stack.
// The model keeps them as two sibling nodes, matching the LaTeX token stream
// (x_i^2); only the layout pairs them: the first script gets a negative right
// margin equal to its own width so the second starts at the same x, and the
// second is at least as wide so whatever follows clears both.

const isScript = (n) => n && (n.type.name === "sub" || n.type.name === "sup");

// Index of the script paired with child `index` of `parent`, or -1.
// Pairing is greedy left to right, so x_a^b_c pairs (_a ^b) and leaves _c alone.
export function scriptPartner(parent, index) {
  for (let i = 0; i < parent.childCount - 1; i++) {
    const a = parent.child(i), b = parent.child(i + 1);
    if (isScript(a) && isScript(b) && a.type !== b.type) {
      if (i === index) return i + 1;
      if (i + 1 === index) return i;
      i++;
    }
  }
  return -1;
}

// An operator with limits (\sum, \lim …) and the one or two scripts right
// after it, not in a script: [operator position, [script positions]]
function limitGroups(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.inlineContent) return true;
    if (node.type.name === "sup" || node.type.name === "sub") return false; // (in small type they stay at the side)
    let offset = pos + 1;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c.type.name === "sym" && LIMITS.has(c.attrs.name) && isScript(node.maybeChild(i + 1))) {
        const scripts = [offset + c.nodeSize];
        const two = isScript(node.maybeChild(i + 2)) && node.child(i + 2).type !== node.child(i + 1).type;
        if (two) scripts.push(scripts[0] + node.child(i + 1).nodeSize);
        out.push([offset, scripts]);
      }
      offset += c.nodeSize;
    }
    return true;
  });
  return out;
}

function pairs(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.inlineContent) return true;
    let offset = pos + 1;
    for (let i = 0; i < node.childCount; i++) {
      const a = node.child(i);
      if (scriptPartner(node, i) === i + 1) out.push([offset, offset + a.nodeSize]);
      offset += a.nodeSize;
    }
    return true;
  });
  return out;
}

// A script on a structure taller than a letter (a fraction, parentheses that
// grow, a root) or on a large operator (\int) goes to its corner, as TeX puts
// it: a superscript up to the base's top, a subscript down to its bottom.
// Never further in than on a letter. [script position, its base's position]
// for each script on one.
function onStructures(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.inlineContent) return true;
    const starts = [];
    let offset = pos + 1;
    node.forEach((c) => { starts.push(offset); offset += c.nodeSize; });
    for (let i = 0; i < node.childCount; i++) {
      if (!isScript(node.child(i))) continue;
      // the base: before the script, or before the pair it is the second of
      const b = scriptPartner(node, i) === i - 1 ? i - 2 : i - 1;
      const base = b >= 0 ? node.child(b) : null;
      if (base?.type.name === "struct" || (base?.type.name === "sym" && SYMBOLS[base.attrs.name]?.cls === "op")) out.push([starts[i], starts[b]]);
    }
    return true;
  });
  return out;
}

// Where the ink of a symbol's glyph is (a large operator's box is far taller
// than the glyph): top and bottom, in the page's coordinates. Otherwise the box.
let ctx = null;
function ink(el) {
  const r = el.getBoundingClientRect();
  if (!el.classList.contains("pm-sym")) return { top: r.top, bottom: r.bottom };
  const cs = getComputedStyle(el);
  ctx ??= document.createElement("canvas").getContext("2d");
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = ctx.measureText(el.textContent), baseline = r.top + m.fontBoundingBoxAscent;
  return { top: baseline - m.actualBoundingBoxAscent, bottom: baseline + m.actualBoundingBoxDescent };
}

// an integral's superscript starts past its slant (KaTeX's italic correction, in ems)
const SLANT = { int: 0.444, iint: 0.444, iiint: 0.444, oint: 0.444, oiint: 0.444, oiiint: 0.444, intop: 0.444 };

// Widths are measured after render and fed back as node decorations, so
// ProseMirror owns every DOM change (writing styles directly would trip its
// mutation observer and re-render in a loop). Converges in one extra pass:
// the first script's own width does not depend on its margin.
function measure(view) {
  const decos = [];
  let sig = "";
  // limits: each script centred over or under the operator (moved there from
  // where it is drawn now, --lx, so that it converges) and taking no width;
  // the operator made as wide as the widest of them
  const limited = new Set();
  for (const [op, scripts] of limitGroups(view.state.doc)) {
    const opEl = view.nodeDOM(op), els = scripts.map((p) => view.nodeDOM(p));
    if (!(opEl instanceof HTMLElement) || !els.every((e) => e instanceof HTMLElement)) continue;
    const ro = opEl.getBoundingClientRect(), em = parseFloat(getComputedStyle(opEl).fontSize) || 16, glyph = ink(opEl);
    const wide = Math.max(ro.width, ...els.map((e) => e.getBoundingClientRect().width));
    const opNode = view.state.doc.nodeAt(op);
    const side = ((wide - ro.width) / 2).toFixed(1);
    // (and the thin space after a large operator)
    decos.push(Decoration.node(op, op + opNode.nodeSize, { class: "pm-limits", style: `margin-left:${side}px;margin-right:calc(${side}px + .167em)` }));
    sig += `${op}|${side};`;
    scripts.forEach((p, k) => {
      const el = els[k], r = el.getBoundingClientRect(), node = view.state.doc.nodeAt(p), up = node.type.name === "sup";
      const lx = (parseFloat(el.style.getPropertyValue("--lx")) || 0) + (ro.left + ro.width / 2) - (r.left + r.width / 2);
      // above: its bottom a little over the operator's top; below: its top a little under its bottom
      const now = parseFloat(el.style.getPropertyValue("--shift")) || 0;
      const shift = Math.max(0, now + (up ? r.bottom - (glyph.top - 0.05 * em) : glyph.bottom + 0.05 * em - r.top));
      const style = `--lx:${lx.toFixed(1)}px;--shift:${shift.toFixed(1)}px;margin-right:${-r.width.toFixed(2)}px`;
      decos.push(Decoration.node(p, p + node.nodeSize, { class: "pm-limit", style }));
      sig += `${p}|${lx.toFixed(1)},${shift.toFixed(1)},${r.width.toFixed(1)};`;
      limited.add(p);
    });
  }
  for (const [p1, p2] of pairs(view.state.doc)) {
    if (limited.has(p1)) continue;
    const first = view.nodeDOM(p1), second = view.nodeDOM(p2);
    if (!(first instanceof HTMLElement && second instanceof HTMLElement)) continue;
    const w = first.getBoundingClientRect().width.toFixed(2);
    const n1 = view.state.doc.nodeAt(p1), n2 = view.state.doc.nodeAt(p2);
    decos.push(Decoration.node(p1, p1 + n1.nodeSize, { class: "pm-stack-first", style: `margin-right:${-w}px` }));
    decos.push(Decoration.node(p2, p2 + n2.nodeSize, { class: "pm-stack-second", style: `min-width:${w}px` }));
    sig += `${p1}:${w};`;
  }
  // how far a script on a structure moves out (--shift, px): from where it is
  // drawn now, so that it converges
  for (const [p, b] of onStructures(view.state.doc)) {
    if (limited.has(p)) continue;
    const el = view.nodeDOM(p), base = view.nodeDOM(b);
    if (!(el instanceof HTMLElement && base instanceof HTMLElement)) continue;
    const node = view.state.doc.nodeAt(p), up = node.type.name === "sup";
    const r = el.getBoundingClientRect(), rb = ink(base);
    const now = parseFloat(el.style.getPropertyValue("--shift")) || 0;
    const em = parseFloat(getComputedStyle(base).fontSize) || 16;
    // a superscript's top a little above the base's, a subscript's bottom a little below
    const off = up ? r.top - (rb.top - 0.12 * em) : rb.bottom + 0.12 * em - r.bottom;
    const shift = Math.max(0, Math.round((now + off) * 2) / 2);
    const op = view.state.doc.nodeAt(b).type.name === "sym";
    const slant = up && op ? (SLANT[view.state.doc.nodeAt(b).attrs.name] ?? 0) * em : 0;
    // the thin space after a large operator comes after its scripts
    const last = op && !isScript(view.state.doc.resolve(p + node.nodeSize).nodeAfter);
    if (!shift && !slant && !last) continue;
    decos.push(Decoration.node(p, p + node.nodeSize, { style: `--shift:${shift}px;margin-left:${slant.toFixed(1)}px${last ? ";margin-right:.167em" : ""}` }));
    sig += `${p}^${shift},${slant.toFixed(1)};`;
  }
  return { set: DecorationSet.create(view.state.doc, decos), sig };
}

const key = new PluginKey("scriptStacking");

export const scriptStacking = new Plugin({
  key,
  state: {
    init: () => ({ set: DecorationSet.empty, sig: "" }),
    apply: (tr, old) => tr.getMeta(key) ?? (tr.docChanged ? { set: old.set.map(tr.mapping, tr.doc), sig: "stale" } : old),
  },
  props: { decorations: (state) => key.getState(state).set },
  // Measured again when the document changed, or after its own decorations
  // went in (the pass that converges); a selection moving changes no width.
  // Once a frame at most.
  view(view) {
    let frame = 0;
    const sync = () => {
      frame = 0;
      if (view.isDestroyed) return; // a re-render destroyed it before this frame
      const next = measure(view);
      if (next.sig !== key.getState(view.state).sig) view.dispatch(view.state.tr.setMeta(key, next));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    schedule();
    document.fonts?.ready.then(sync);
    return {
      update: (v, prev) => { if (v.state.doc !== prev.doc || key.getState(v.state) !== key.getState(prev)) schedule(); },
      destroy: () => cancelAnimationFrame(frame),
    };
  },
});
