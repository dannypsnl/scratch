import katex from "katex";
import { SYMBOLS, STRUCTS } from "./specs.js";
import { insertStruct, insertSym, insertLetterStruct } from "./nav.js";
import { place } from "./popover.js";
import { t } from "./i18n.js";

// "\" inside a formula opens this. Everything structural is summoned here,
// including commands the spec table does not know (the last entry).

const ENTRIES = [
  ...Object.entries(STRUCTS).map(([name, s]) => ({ name, kind: "struct", arity: s.arity, tex: s.example, note: t("palette.slots", s.arity) })),
  ...Object.entries(SYMBOLS).map(([name, s]) => ({ name, kind: "sym", tex: s.preview ?? "\\" + name })),
];

// Rendered preview of what the entry inserts.
const previews = new Map();
function preview(tex) {
  if (!previews.has(tex)) previews.set(tex, katex.renderToString(tex, { throwOnError: false }));
  return previews.get(tex);
}

// subsequence match; lower is better, null = no match
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

export function openPalette(view, initial = "") {
  const coords = view.coordsAtPos(view.state.selection.from);
  const box = document.createElement("div");
  box.className = "palette";
  place(box, coords);
  const input = document.createElement("input");
  input.placeholder = "\\command";
  input.value = initial;
  const list = document.createElement("ul");
  box.append(input, list);
  document.body.append(box);

  let items = [], active = 0, askArity = null;

  const close = () => { box.remove(); view.focus(); };
  const run = (item) => {
    close();
    if (item.kind === "sym") insertSym(view.state, view.dispatch, item.name);
    else if (item.kind === "struct" && STRUCTS[item.name].letter) openLetter(view, item.name);
    else if (item.kind === "struct") insertStruct(view.state, view.dispatch, item.name, item.arity);
    else if (item.kind === "generic") {
      // second stage: how many argument slots
      openArity(view, item.name);
    }
  };

  function render() {
    const q = input.value.replace(/^\\/, "");
    items = ENTRIES.map((e) => ({ e, s: score(e.name, q) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => a.s - b.s)
      .slice(0, 8)
      .map((x) => x.e);
    if (/^[a-zA-Z]+$/.test(q) && !items.some((e) => e.name === q)) {
      items.push({ name: q, kind: "generic", note: t("palette.generic") });
    }
    active = Math.min(active, Math.max(items.length - 1, 0));
    list.replaceChildren(...items.map((it, k) => {
      const li = document.createElement("li");
      li.className = k === active ? "active" : "";
      li.innerHTML = `<span class="cmd">\\${it.name}</span><span class="pv">${it.tex ? preview(it.tex) : ""}</span><span class="note"></span>`;
      li.querySelector(".note").textContent = it.note ?? "";
      li.onmousedown = (ev) => { ev.preventDefault(); run(it); };
      return li;
    }));
  }

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { active = (active + 1) % items.length; render(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { active = (active - 1 + items.length) % items.length; render(); ev.preventDefault(); }
    else if (ev.key === "Enter" || ev.key === "Tab") { if (items[active]) run(items[active]); ev.preventDefault(); }
    else if (ev.key === "Escape" || (ev.key === "Backspace" && input.value === "")) { close(); ev.preventDefault(); }
  });
  closeOnBlur(input, box);
  render();
  input.focus();
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
