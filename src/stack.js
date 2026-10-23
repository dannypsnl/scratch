import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

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

// Widths are measured after render and fed back as node decorations, so
// ProseMirror owns every DOM change (writing styles directly would trip its
// mutation observer and re-render in a loop). Converges in one extra pass:
// the first script's own width does not depend on its margin.
function measure(view) {
  const decos = [];
  let sig = "";
  for (const [p1, p2] of pairs(view.state.doc)) {
    const first = view.nodeDOM(p1), second = view.nodeDOM(p2);
    if (!(first instanceof HTMLElement && second instanceof HTMLElement)) continue;
    const w = first.getBoundingClientRect().width.toFixed(2);
    const n1 = view.state.doc.nodeAt(p1), n2 = view.state.doc.nodeAt(p2);
    decos.push(Decoration.node(p1, p1 + n1.nodeSize, { class: "pm-stack-first", style: `margin-right:${-w}px` }));
    decos.push(Decoration.node(p2, p2 + n2.nodeSize, { class: "pm-stack-second", style: `min-width:${w}px` }));
    sig += `${p1}:${w};`;
  }
  return { set: DecorationSet.create(view.state.doc, decos), sig };
}

const key = new PluginKey("scriptStacking");

export const scriptStacking = new Plugin({
  key,
  state: {
    init: () => ({ set: DecorationSet.empty, sig: "" }),
    apply: (tr, old) => tr.getMeta(key) ?? { set: old.set.map(tr.mapping, tr.doc), sig: tr.docChanged ? "stale" : old.sig },
  },
  props: { decorations: (state) => key.getState(state).set },
  view(view) {
    const sync = () => {
      if (view.isDestroyed) return; // a re-render destroyed it before this frame
      const next = measure(view);
      if (next.sig !== key.getState(view.state).sig) view.dispatch(view.state.tr.setMeta(key, next));
    };
    requestAnimationFrame(sync);
    document.fonts?.ready.then(sync);
    return { update: () => requestAnimationFrame(sync) };
  },
});
