import * as Neutralino from "@neutralinojs/lib";
import { inNeutralino, persistence } from "./persist.js";

// TEMPORARY: records input-method events and the transactions they lead to,
// to find why committing a Zhuyin composition duplicates text in WebKit.
// Written to <data>/scratch/ime.log. Remove once fixed.

let buf = [];
let timer = null;
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

function flush() {
  timer = null;
  if (!buf.length || !persistence.dir?.()) return;
  const text = buf.join("\n") + "\n";
  buf = [];
  Neutralino.filesystem.appendFile(persistence.dir() + "/ime.log", text).catch(() => {});
}
function log(line) {
  buf.push(`${ms()}\t${line}`);
  if (!timer) timer = setTimeout(flush, 300);
}

// the blocks around the caret, as text, to see duplication happen
function around(state) {
  const { $head } = state.selection;
  let d = $head.depth;
  while (d > 0 && $head.node(d).type.name !== "block") d--;
  const parent = d > 1 ? $head.node(d - 1) : state.doc;
  const lines = [];
  parent.forEach((b) => { if (b.type.name === "block") lines.push(JSON.stringify(b.firstChild.textContent)); });
  return `head=${$head.pos} lines=[${lines.join(",")}]`;
}

const caller = () => (new Error().stack ?? "").split("\n").slice(3, 7).map((l) => l.trim().replace(/\?t=\d+/, "").replace(/https?:\/\/[^/]+/, "")).join(" < ");

export function imeLog(view) {
  if (!inNeutralino) return;
  const dom = view.dom;
  const domLine = () => {
    const sel = document.getSelection();
    const n = sel?.anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement)?.closest(".pm-body");
    return el ? JSON.stringify(el.textContent) : "-";
  };
  for (const type of ["compositionstart", "compositionupdate", "compositionend", "keydown", "keypress", "keyup", "beforeinput", "input"]) {
    dom.addEventListener(type, (e) => {
      const parts = [type];
      if (e.key !== undefined) parts.push(`key=${JSON.stringify(e.key)} code=${e.keyCode}`);
      if (e.inputType) parts.push(`inputType=${e.inputType}`);
      if (e.data !== undefined && e.data !== null) parts.push(`data=${JSON.stringify(e.data)}`);
      if ("isComposing" in e) parts.push(`isComposing=${e.isComposing}`);
      parts.push(`pm.composing=${view.composing} ts=${Math.round(e.timeStamp)} dom=${domLine()}`);
      log(parts.join(" "));
    }, true);
  }
  return {
    note: (line) => log("  NOTE " + line),
    tr(tr, prev, next) {
      if (!tr.docChanged && prev.selection.eq(next.selection)) return;
      const steps = tr.steps.map((s) => { const j = s.toJSON(); return `${j.stepType}${j.from !== undefined ? `(${j.from},${j.to})` : ""}${j.slice ? ":" + JSON.stringify(j.slice).slice(0, 80) : ""}`; }).join(" ");
      log(`  TR doc=${tr.docChanged} ${steps} -> ${around(next)}  via ${caller()}`);
    },
  };
}
