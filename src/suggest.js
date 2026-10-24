import { Plugin, PluginKey } from "prosemirror-state";
import { isMathContainer } from "./schema.js";
import { inText } from "./nav.js";
import { ENTRIES, preview, insertEntry } from "./palette.js";
import { place } from "./popover.js";

// Typing in a formula works like a search, without "\": a word of letters
// just typed before the caret that names a command, or starts its name (or a
// plain word for it: root, integral, infinity …), brings up suggestions
// under it. Enter or Tab takes the highlighted one, ⌘1 … ⌘9 one by number,
// ↑ ↓ move; Space or Escape leaves the letters as they are (variables
// side by side), and so does typing on.

// plain words for commands whose names are not words
const WORDS = {
  root: "sqrt", squareroot: "sqrt", fraction: "frac", integral: "int", infinity: "infty", product: "prod",
  union: "cup", intersection: "cap", element: "in", sine: "sin", cosine: "cos", tangent: "tan",
  limit: "lim", plusminus: "pm", dot: "cdot", arrow: "to", implies: "Rightarrow", empty: "emptyset",
  notequal: "neq", vector: "vec", bar: "overline", abs: "left|", norm: "left\\|", paren: "left(",
  derivative: "partial", degree: "circ", approx: "approx", times: "times",
};
const byName = new Map(ENTRIES.map((e) => [e.name, e]));

// The suggestions for a word: the command it is a plain word for, the one
// named by it, then those whose
// name (or plain word) starts with it, shorter first. None for one letter.
export function suggestions(word) {
  if (word.length < 2) return [];
  const found = new Map();
  const add = (e, rank, via) => { if (e && (!found.has(e.name) || found.get(e.name).rank > rank)) found.set(e.name, { ...e, rank, via }); };
  if (WORDS[word]) add(byName.get(WORDS[word]), 0, word);
  add(byName.get(word), 1);
  for (const e of ENTRIES) if (e.name.startsWith(word)) add(e, 2 + e.name.length / 100);
  for (const [w, name] of Object.entries(WORDS)) if (w.startsWith(word)) add(byName.get(name), 3 + w.length / 100, w);
  return [...found.values()].sort((a, b) => a.rank - b.rank).slice(0, 9);
}

// the word of letters just before an empty selection in a formula, or null
function wordBefore(state) {
  const { $head, empty } = state.selection;
  if (!empty || !isMathContainer($head.parent.type) || inText($head) || !$head.nodeBefore?.isText) return null;
  const m = /[A-Za-z]+$/.exec($head.nodeBefore.text);
  return m ? { from: $head.pos - m[0].length, to: $head.pos, word: m[0] } : null;
}

const key = new PluginKey("suggest");

// state: { from, to, word, items, active } while suggesting, else null
export const suggest = new Plugin({
  key,
  state: {
    init: () => null,
    apply(tr, old, _, state) {
      const meta = tr.getMeta(key);
      if (meta !== undefined) return meta === "close" ? null : { ...old, active: meta };
      // only right after a letter is typed (not on moving next to a word);
      // what changes neither the document nor the selection leaves it be
      if (!tr.docChanged) return tr.selectionSet ? null : old;
      // ("notTyped": text put in that nobody typed, an answer or another notation)
      if (tr.getMeta("composition") || tr.getMeta("paste") || tr.getMeta("notTyped")) return null;
      const w = wordBefore(state);
      if (!w || tr.doc.content.size <= tr.before.content.size) return null;
      const items = suggestions(w.word);
      return items.length ? { ...w, items, active: 0 } : null;
    },
  },
  props: {
    handleKeyDown(view, ev) {
      const s = key.getState(view.state);
      if (!s || view.composing) return false;
      const move = (k) => { view.dispatch(view.state.tr.setMeta(key, (s.active + k + s.items.length) % s.items.length)); return true; };
      if (ev.key === "ArrowDown") return move(1);
      if (ev.key === "ArrowUp") return move(-1);
      if (ev.key === "Escape") { view.dispatch(view.state.tr.setMeta(key, "close")); return true; }
      // (plain Enter or Tab: ⌘⇧↵ and the like are keys of their own)
      const plain = !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey;
      const n = (ev.metaKey || ev.ctrlKey) && /^[1-9]$/.test(ev.key) ? Number(ev.key) - 1 : plain && (ev.key === "Enter" || ev.key === "Tab") ? s.active : -1;
      if (n >= 0 && s.items[n]) { take(view, s, s.items[n]); return true; }
      if (ev.key === " ") view.dispatch(view.state.tr.setMeta(key, "close")); // and Space does what it does
      return false;
    },
  },
  view(view) {
    const box = Object.assign(document.createElement("div"), { className: "palette suggest", hidden: true });
    document.body.append(box);
    let shown = null;
    const draw = () => {
      const s = key.getState(view.state);
      box.hidden = !s || !view.hasFocus();
      if (box.hidden) { shown = null; return; }
      const list = document.createElement("ul");
      list.append(...s.items.map((it, k) => {
        const li = document.createElement("li");
        li.className = k === s.active ? "active" : "";
        li.innerHTML = `<span class="cmd"></span><span class="pv">${it.tex ? preview(it.tex) : ""}</span><span class="note"></span>`;
        li.querySelector(".cmd").textContent = it.via ? `${it.via} \\${it.name}` : `\\${it.name}`;
        li.querySelector(".note").textContent = `⌘${k + 1}`;
        li.onmousedown = (ev) => { ev.preventDefault(); take(view, s, it); };
        return li;
      }));
      box.replaceChildren(list);
      // placed where the word starts, once per word (moving through the list keeps it still)
      if (shown !== s.from) { shown = s.from; place(box, view.coordsAtPos(s.from)); }
    };
    draw();
    return { update: draw, destroy: () => box.remove() };
  },
});

// the word goes, and what was picked takes its place
function take(view, s, item) {
  view.dispatch(view.state.tr.delete(s.from, s.to).setMeta(key, "close"));
  insertEntry(view, item);
}
