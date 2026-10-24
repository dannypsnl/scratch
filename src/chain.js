import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema } from "./schema.js";
import { SYMBOLS } from "./specs.js";

// A derivation written a step a line:
//   - $a = b$ because …
//   - $= c$ by …
//   - $= d$
// A line whose formula starts with a relation goes on from the line before
// it (a sibling, back to one with a relation of its own): its relation is
// drawn under that line's first relation, and the text after each formula
// of the chain starts at one column. Only drawn so: the notes stay plain
// outline text.

const T = schema.nodes;
const GAP = 24; // between the widest formula of a chain and its notes
const isRel = (n) => (n.isText ? /[=<>]/.test(n.text) : n.type === T.sym && SYMBOLS[n.attrs.name]?.cls === "rel");
const leadsWithRel = (n) => !!n && (n.isText ? /^[=<>]/.test(n.text) : n.type === T.sym && SYMBOLS[n.attrs.name]?.cls === "rel");

// the line's formula when the line starts with it
const firstMath = (line) => (line?.type === T.line && line.firstChild?.type === T.math ? line.firstChild : null);
export const continues = (line) => leadsWithRel(firstMath(line)?.firstChild);
function hasRel(line) {
  const m = firstMath(line);
  let found = false;
  m?.forEach((n) => { if (isRel(n)) found = true; });
  return found;
}

// [[{ id, pos, line }]]: each chain, its first line first
function chains(doc) {
  const out = [];
  const walk = (parent, start) => {
    let chain = null;
    parent.forEach((block, offset) => {
      if (block.type !== T.block) return;
      const pos = start + offset, line = block.firstChild;
      const entry = { id: block.attrs.id, pos: pos + 1, line };
      if (chain && continues(line)) chain.push(entry);
      else {
        if (chain?.length > 1) out.push(chain);
        chain = hasRel(line) && !continues(line) ? [entry] : null;
      }
      walk(block, pos + 1);
    });
    if (chain?.length > 1) out.push(chain);
  };
  walk(doc, 0);
  return out;
}

const key = new PluginKey("chain");
const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => Math.abs((b.get(k) ?? -1) - v) < 0.5);

export const derivations = new Plugin({
  key,
  // pads: block id -> px before the line; notes: block id -> px before its note
  state: {
    init: () => ({ pads: new Map(), notes: new Map() }),
    apply: (tr, old) => tr.getMeta(key) ?? old,
  },
  props: {
    decorations(state) {
      const { pads, notes } = key.getState(state);
      if (!pads.size && !notes.size) return null;
      const decos = [];
      for (const chain of chains(state.doc)) for (const { id, pos, line } of chain) {
        const pad = pads.get(id);
        if (pad) decos.push(Decoration.node(pos, pos + line.nodeSize, { style: `padding-left: ${pad}px` }));
        const note = notes.get(id);
        if (note) {
          const at = pos + 1 + line.firstChild.nodeSize;
          decos.push(Decoration.widget(at, () => Object.assign(document.createElement("span"), { className: "chain-gap", style: `width: ${note}px` }), { side: -1, key: `gap-${note}`, ignoreSelection: true }));
        }
      }
      return DecorationSet.create(state.doc, decos);
    },
  },
  view(view) {
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (view.isDestroyed) return;
      const { pads: oldPads, notes: oldNotes } = key.getState(view.state);
      const pads = new Map(), notes = new Map();
      for (const chain of chains(view.state.doc)) {
        const rows = chain.map(({ id, pos, line }) => {
          const el = view.nodeDOM(pos);
          const math = el?.querySelector?.(":scope > .pm-math");
          const rel = math?.querySelector(":scope > .pm-rel");
          if (!rel) return null;
          const pad = oldPads.get(id) ?? 0;
          const note = line.childCount > 1 && line.textBetween(line.firstChild.nodeSize, line.content.size).trim() !== "";
          return { id, el, pad, note, rel: rel.getBoundingClientRect().left - pad, right: math.getBoundingClientRect().right - pad };
        });
        if (rows.some((r) => !r)) continue;
        const x = rows[0].rel;
        for (const r of rows.slice(1)) r.newPad = Math.max(0, Math.round((x - r.rel) * 10) / 10);
        rows[0].newPad = 0;
        for (const r of rows) if (r.newPad) pads.set(r.id, r.newPad);
        // notes at one column, unless that column leaves them no room
        if (rows.filter((r) => r.note).length) {
          const column = Math.max(...rows.map((r) => r.right + r.newPad)) + GAP;
          if (column < view.dom.getBoundingClientRect().right - 120) {
            for (const r of rows) if (r.note) notes.set(r.id, Math.round((column - (r.right + r.newPad)) * 10) / 10);
          }
        }
      }
      if (!same(pads, oldPads) || !same(notes, oldNotes)) view.dispatch(view.state.tr.setMeta(key, { pads, notes }).setMeta("addToHistory", false));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    window.addEventListener("resize", schedule);
    document.fonts?.ready.then(schedule);
    schedule();
    return {
      update: (v, prev) => { if (v.state.doc !== prev.doc || key.getState(v.state) !== key.getState(prev)) schedule(); },
      destroy: () => { cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); },
    };
  },
});
