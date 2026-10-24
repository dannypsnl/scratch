import { Plugin, TextSelection } from "prosemirror-state";
import { toggleMark } from "prosemirror-commands";
import { schema } from "./schema.js";
import { inMath } from "./nav.js";
import { t } from "./i18n.js";

// The format bar: over a selection of text, one button for each mark that
// can be put on it (bold, italic, underline, strikethrough, highlight), the
// marks the whole selection already has shown pressed. Like the formula hint
// (notation.js), one box for the whole app, drawn from the focused editor
// alone on every update and focus change.

const M = schema.marks;
const BUTTONS = [
  { mark: M.strong, key: "format.bold", keys: "⌘B", glyph: ["b", "B"] },
  { mark: M.em, key: "format.italic", keys: "⌘I", glyph: ["i", "I"] },
  { mark: M.underline, key: "format.underline", keys: "⌘U", glyph: ["u", "U"] },
  { mark: M.strike, key: "format.strike", keys: "⌘⇧X", glyph: ["s", "S"] },
  { mark: M.highlight, key: "format.highlight", keys: "⌘⇧H", glyph: ["mark", "H"] },
];

// every piece of text in the selection has the mark
function allHave(state, type) {
  const { from, to } = state.selection;
  let seen = false, all = true;
  state.doc.nodesBetween(from, to, (n) => {
    if (n.isText) { seen = true; if (!type.isInSet(n.marks)) all = false; }
  });
  return seen && all;
}

// a selection of text outside formulas, which marks can go on
function applies(state) {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || sel.empty) return false;
  if (inMath(sel.$from) || inMath(sel.$to)) return false;
  return toggleMark(M.strong)(state);
}

const editors = new Set();
let box = null;

function draw() {
  box ??= Object.assign(document.createElement("div"), { className: "format-bar", hidden: true });
  if (!box.isConnected) document.body.append(box);
  const view = [...editors].find((v) => v.dom.isConnected && v.hasFocus());
  box.hidden = !view || !applies(view.state);
  if (box.hidden) return;
  box.replaceChildren(...BUTTONS.map(({ mark, key, keys, glyph }) => {
    const b = document.createElement("button");
    b.title = `${t(key)}  ${keys}`;
    b.setAttribute("aria-label", t(key));
    b.setAttribute("aria-pressed", String(allHave(view.state, mark)));
    b.append(Object.assign(document.createElement(glyph[0]), { textContent: glyph[1] }));
    // mousedown, not click: the editor keeps its focus and its selection
    b.onmousedown = (ev) => { ev.preventDefault(); toggleMark(mark)(view.state, view.dispatch); };
    return b;
  }));
  // over the selection's first line, its left edge at the selection's start
  const { from, to } = view.state.selection;
  const a = view.coordsAtPos(from), z = view.coordsAtPos(to);
  const top = Math.min(a.top, z.top) - box.offsetHeight - 6;
  box.style.left = `${Math.max(8, a.left) + window.scrollX}px`;
  box.style.top = `${(top < 8 ? Math.max(a.bottom, z.bottom) + 6 : top) + window.scrollY}px`;
}
let listening = false;

export const formatBar = new Plugin({
  view(view) {
    if (!listening) {
      listening = true;
      document.addEventListener("focusin", () => queueMicrotask(draw));
      document.addEventListener("focusout", () => queueMicrotask(draw));
    }
    editors.add(view);
    draw();
    return { update: draw, destroy: () => { editors.delete(view); draw(); } };
  },
});
