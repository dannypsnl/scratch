import katex from "katex";
import { SYMBOLS, STRUCTS, X_ARROWS, FAMILIES } from "./specs.js";
import { insertStruct, insertSym, insertLetterStruct } from "./nav.js";
import { place } from "./popover.js";
import { selectionActions, applyNotation } from "./notation.js";
import { t } from "./i18n.js";

// "\" inside a formula opens this. Everything structural is summoned here,
// including commands the spec table does not know (the last entry).

export const ENTRIES = [
  ...Object.entries(STRUCTS).map(([name, s]) => ({ name, kind: "struct", arity: s.arity, tex: s.example, note: t("palette.slots", s.arity) })),
  ...Object.entries(SYMBOLS).map(([name, s]) => ({ name, kind: "sym", tex: s.preview ?? "\\" + name,
    rank: s.rank, ams: s.ams, family: Object.keys(FAMILIES).find((f) => FAMILIES[f](s.char)) })),
  // \xrightarrow and kin: an \overset over the arrow (nav.js insertStruct)
  ...Object.keys(X_ARROWS).map((name) => ({ name, kind: "struct", arity: 1, tex: `\\${name}{f}`, note: t("palette.slots", 2), family: "arrow" })),
];

// Rendered preview of what the entry inserts.
const previews = new Map();
export function preview(tex) {
  if (!previews.has(tex)) previews.set(tex, katex.renderToString(tex, { throwOnError: false }));
  return previews.get(tex);
}

// subsequence match on the name; lower is better, null = no match
function score(name, q) {
  if (!q) return 0;
  if (name === q) return -2;
  if (name.startsWith(q)) return -1 + name.length / 100;
  let i = 0, gaps = 0, last = -1;
  for (let k = 0; k < name.length && i < q.length; k++) {
    if (name[k] === q[i]) { if (last >= 0) gaps += k - last - 1; last = k; i++; }
  }
  return i === q.length ? gaps + name.length / 100 : null;
}

// A family's name ("arrow") matches every member too: the common ones
// (specs.js COMMON) first in their order, then those whose names match, then
// the rest, KaTeX's own before the AMS ones.
function rank(e, q) {
  const s = score(e.name, q);
  if (e.family !== q) return s;
  if (e.rank !== undefined) return -1.5 + e.rank / 1000;
  return s ?? 50 + (e.ams ? 1 : 0);
}

// The entries the menu lists for a query, best first: the first 8, or every
// match when the query names a family (the list scrolls).
export function ranked(entries, q) {
  const all = entries.map((e) => ({ e, s: rank(e, q) })).filter((x) => x.s !== null).sort((a, b) => a.s - b.s).map((x) => x.e);
  return FAMILIES[q] ? all : all.slice(0, 8);
}

// The \ menu of commands; or, actionsOnly, the menu Space opens on a
// selection: what can be done with it (they are not in the \ menu)
export function openPalette(view, initial = "", { actionsOnly = false } = {}) {
  const offered = actionsOnly ? selectionActions(view.state) : [];
  if (actionsOnly && !offered.length) return;
  const coords = view.coordsAtPos(view.state.selection.from);
  const box = document.createElement("div");
  box.className = "palette";
  place(box, coords);
  const input = document.createElement("input");
  input.placeholder = "\\command";
  if (actionsOnly) input.className = "hidden-input"; // ↑ ↓ Enter only
  input.value = initial;
  const list = document.createElement("ul");
  box.append(input, list);
  document.body.append(box);

  let items = [], active = 0, askArity = null;
  const actions = offered.map((a) => ({ name: a.id, kind: "action", tex: a.tex, note: a.label, action: a }));

  const close = () => { box.remove(); view.focus(); };
  const run = (item) => {
    close();
    if (item.kind === "action") applyNotation(view, item.action);
    else insertEntry(view, item);
  };

  function render() {
    const q = input.value.replace(/^\\/, "");
    items = ranked(actionsOnly ? actions : [...actions, ...ENTRIES], q);
    if (!actionsOnly && !FAMILIES[q] && /^[a-zA-Z]+$/.test(q) && !items.some((e) => e.name === q)) {
      items.push({ name: q, kind: "generic", note: t("palette.generic") });
    }
    active = Math.min(active, Math.max(items.length - 1, 0));
    list.replaceChildren(...items.map((it, k) => {
      const li = document.createElement("li");
      li.className = k === active ? "active" : "";
      li.innerHTML = `<span class="cmd"></span><span class="pv">${it.tex ? preview(it.tex) : ""}</span><span class="note"></span>`;
      // an action is named by what it does; a command by its \\name
      li.querySelector(".cmd").textContent = it.kind === "action" ? it.note : "\\" + it.name;
      // (a Nerdamer action shows its answer, and is not a change of notation)
      li.querySelector(".note").textContent = it.kind === "action" ? (it.action.input ? "" : t("notation.note")) : it.note ?? "";
      // an action with a key of its own in a formula (^ _) takes it here too
      if (it.action?.key) li.querySelector(".note").prepend(Object.assign(document.createElement("kbd"), { textContent: it.action.key }), " ");
      li.onmousedown = (ev) => { ev.preventDefault(); run(it); };
      return li;
    }));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { active = (active + 1) % items.length; render(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { active = (active - 1 + items.length) % items.length; render(); ev.preventDefault(); }
    else if (ev.key === "Enter" || ev.key === "Tab") { if (items[active]) run(items[active]); ev.preventDefault(); }
    else if (ev.key === "Escape" || (ev.key === "Backspace" && input.value === "")) { close(); ev.preventDefault(); }
    else if (actionsOnly && actions.some((a) => a.action.key === ev.key)) { run(actions.find((a) => a.action.key === ev.key)); ev.preventDefault(); }
  });
  closeOnBlur(input, box);
  render();
  input.focus();
}

// What an entry inserts, at the caret (or around the selection)
export function insertEntry(view, item) {
  if (item.kind === "sym") insertSym(view.state, view.dispatch, item.name);
  else if (item.kind === "struct" && STRUCTS[item.name]?.letter && view.state.selection.empty) openLetter(view, item.name);
  else if (item.kind === "struct") insertStruct(view.state, view.dispatch, item.name, item.arity);
  else if (item.kind === "generic") openArity(view, item.name); // second stage: how many argument slots
}

function openArity(view, name) {
  const coords = view.coordsAtPos(view.state.selection.from);
  const box = document.createElement("div");
  box.className = "palette";
  place(box, coords);
  box.innerHTML = `<div class="ask">${t("palette.arity", name)}</div>`;
  const input = document.createElement("input");
  input.className = "hidden-input";
  box.append(input);
  document.body.append(box);
  const close = () => { box.remove(); view.focus(); };
  input.addEventListener("keydown", (ev) => {
    ev.preventDefault();
    if (/^[1-9]$/.test(ev.key)) { close(); insertStruct(view.state, view.dispatch, name, Number(ev.key)); }
    else if (ev.key === "Escape") close();
  });
  closeOnBlur(input, box);
  input.focus();
}

// Close when focus moves elsewhere in the page, but survive switching windows.
function closeOnBlur(input, box) {
  input.addEventListener("blur", () => setTimeout(() => {
    if (document.hasFocus() && document.activeElement !== input && box.isConnected) box.remove();
  }));
}

// \mathbb, \mathcal: the next letter typed is the argument. Common letters
// are offered too: Tab / Shift-Tab (or ← →) to choose, Enter to insert.
const COMMON = { mathbb: "NZQRCFPA", mathcal: "CDFOLAH" };

function openLetter(view, name) {
  const coords = view.coordsAtPos(view.state.selection.from);
  const box = document.createElement("div");
  box.className = "palette letter-picker";
  place(box, coords);
  const letters = [...(COMMON[name] ?? "")];
  box.innerHTML = `<div class="ask">${t("palette.letter", name)}</div><div class="choices"></div>`;
  const choices = box.querySelector(".choices");
  const input = document.createElement("input");
  input.className = "hidden-input";
  box.append(input);
  document.body.append(box);

  let active = 0;
  const close = () => { box.remove(); view.focus(); };
  const pick = (c) => { close(); insertLetterStruct(view.state, view.dispatch, name, c); };
  const draw = () => {
    choices.replaceChildren(...letters.map((c, k) => {
      const b = document.createElement("span");
      b.className = "choice" + (k === active ? " active" : "");
      b.innerHTML = preview(`\\${name}{${c}}`);
      b.onmousedown = (e) => { e.preventDefault(); pick(c); };
      return b;
    }));
  };
  draw();

  input.addEventListener("keydown", (ev) => {
    ev.preventDefault();
    const step = (d) => { active = (active + d + letters.length) % letters.length; draw(); };
    if (ev.key === "Tab") step(ev.shiftKey ? -1 : 1);
    else if (ev.key === "ArrowRight") step(1);
    else if (ev.key === "ArrowLeft") step(-1);
    else if (ev.key === "Enter") pick(letters[active]);
    else if (/^[A-Za-z0-9]$/.test(ev.key)) pick(ev.key);
    else if (ev.key === "Escape" || ev.key === "Backspace") close();
  });
  closeOnBlur(input, box);
  input.focus();
}
