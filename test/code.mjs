// Typing in and around inline code (code.js): each case starts from a line
// with a caret or selection marked in it, types its keys through the
// editor's own handlers, and checks the line, with the caret or selection
// marked, afterwards. Then the same for a selection in a code block, and
// Escape out of one.
//
//   `…` inline code, its backticks drawn; \` a backtick typed as it is; | a
//   caret; [ ] a selection. A caret at the edge of a code run is inside its
//   backtick (`ab|`) or outside it (`ab`|, |`ab`): what the next character
//   typed becomes.
import { EditorState, TextSelection } from "prosemirror-state";
import { schema } from "../src/schema.js";
import { parseInline, parseOutline, serializeOutline } from "../src/outline-io.js";
import { typeInCode, codeStep, codeDelete, exitCodeBlock, marksAt } from "../src/code.js";

const T = schema.nodes;
const CODE = schema.marks.code;

// [line, keys, line afterwards]. A key is a character typed, or a name.
const CASES = [
  // ` is a backtick until the next one closes `…` into code
  ["x| y", ["`", "c"], "x\\`c| y"],
  ["x| y", ["`", "c", "d", "`", "e"], "x`cd`e| y"],
  // `` and ``` stay as typed (``` then ↵ opens a code block)
  ["x| y", ["`", "`", "z"], "x\\`\\`z| y"],
  ["|", ["`", "`", "`"], "\\`\\`\\`|"],
  // typed at an edge: in or out, as the caret is; between its characters: in it
  ["x`c`| y", ["a"], "x`c`a| y"],
  ["x|`c` y", ["a"], "xa|`c` y"],
  ["x`c|` y", ["a", "b"], "x`cab|` y"],
  ["x`|c` y", ["a"], "x`a|c` y"],
  ["x`a|b` y", ["c"], "x`ac|b` y"],
  ["x`a|b` y", ["`"], "x`a\\`|b` y"],
  // ` just inside the end steps out past it
  ["x`ab|` y", ["`", "c"], "x`ab`c| y"],
  // ← → at the edges: inside and outside the backtick before moving on, the same stops both ways
  ["x`cd`| y", ["ArrowLeft"], "x`cd|` y"],
  ["x`cd|` y", ["ArrowLeft"], "x`c|d` y"],
  ["x`c|d` y", ["ArrowLeft"], "x`|cd` y"],
  ["x`|cd` y", ["ArrowLeft"], "x|`cd` y"],
  ["x|`cd` y", ["ArrowLeft"], "|x`cd` y"],
  ["|x`cd` y", ["ArrowRight"], "x|`cd` y"],
  ["x|`cd` y", ["ArrowRight"], "x`|cd` y"],
  ["x`|cd` y", ["ArrowRight"], "x`c|d` y"],
  ["x`c|d` y", ["ArrowRight"], "x`cd|` y"],
  ["x`cd|` y", ["ArrowRight"], "x`cd`| y"],
  ["x`cd`| y", ["ArrowRight"], "x`cd` |y"],
  ["x`|c` y", ["ArrowRight"], "x`c|` y"],
  ["x`c|` y", ["ArrowLeft"], "x`|c` y"],
  // Backspace or Delete over a backtick: it goes, the other one stays a character
  ["x`cd`| y", ["Backspace"], "x\\`cd| y"],
  ["x`|cd` y", ["Backspace"], "x|cd\\` y"],
  ["x|`cd` y", ["Delete"], "x|cd\\` y"],
  ["x`cd|` y", ["Delete"], "x\\`cd| y"],
  // (inside the end or outside the start, Backspace deletes a character as ever)
  ["x`cd|` y", ["Backspace"], "x`c|` y"],
  ["x|`cd` y", ["Backspace"], "|`cd` y"],
  // deleting in it keeps the caret inside, up to its edges
  ["x`cd|` y", ["Backspace", "e"], "x`ce|` y"],
  ["x`c|d` y", ["Backspace"], "x`|d` y"],
  ["x`|cd` y", ["Delete"], "x`|d` y"],
  ["x`c|` y", ["Backspace"], "x| y"],
  // a bracket or quote on a selection in code wraps it, still selected
  ["x`[ab]` y", ["("], "x`([ab])` y"],
  ["x`[ab]` y", ["(", "["], "x`([[ab]])` y"],
  ["x`a[b]c` y", ["\""], "x`a\"[b]\"c` y"],
  ["x`a[b]c` y", ["{"], "x`a{[b]}c` y"],
  // (elsewhere it is typed over the selection)
  ["x [ab] y", ["("], "x (| y"],
  // ` on a selection: plain text becomes code, code becomes plain
  ["x [ab] y", ["`"], "x `ab`| y"],
  ["x `[ab]` y", ["`"], "x [ab] y"],
];

// The line of a case: its text with code marked, where the caret or
// selection is, and whether a caret at the edge of code is inside it.
function marked(src) {
  let text = "", from = -1, to = -1, inside = null, code = false;
  for (const ch of src) {
    if (ch === "`") code = !code;
    else if (ch === "|" || ch === "[") { from = text.length; if (ch === "|") { to = from; inside = code; } }
    else if (ch === "]") to = text.length;
    else text += ch;
  }
  return { text: src.replace(/[|[\]]/g, ""), from, to, inside };
}

// A state's line as a case is written.
function show(state) {
  const line = state.doc.firstChild.firstChild;
  const chars = [];
  line.forEach((n) => { for (const c of n.text) chars.push({ c, code: n.marks.some((m) => m.type === CODE) }); });
  const { from, to } = state.selection;
  const a = from - 2, b = to - 2; // doc > block > line
  const inside = marksAt(state).some((m) => m.type === CODE);
  let out = "";
  for (let i = 0; i <= chars.length; i++) {
    const ends = chars[i - 1]?.code && !chars[i]?.code, starts = chars[i]?.code && !chars[i - 1]?.code;
    const mark = (i === a ? (a === b ? "|" : "[") : "") + (i === b && a !== b ? "]" : "");
    // a caret at an edge: in or out; a selection's end goes in when the character next to it is code
    const inAt = a === b ? inside : (i === a ? chars[i]?.code : chars[i - 1]?.code);
    if (ends) out += inAt ? mark + "`" : "`" + mark;
    else if (starts) out += inAt ? "`" + mark : mark + "`";
    else out += mark;
    if (i < chars.length) out += chars[i].c === "`" ? "\\`" : chars[i].c;
  }
  return out;
}

function press(view, key) {
  const { state } = view;
  const head = state.selection.head;
  const browserMove = (dir) => view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, head + dir)));
  switch (key) {
    case "Escape": return exitCodeBlock(state, view.dispatch);
    case "ArrowLeft": return codeStep(-1)(state, view.dispatch) || browserMove(-1);
    case "ArrowRight": return codeStep(1)(state, view.dispatch) || browserMove(1);
    case "Backspace": return codeDelete(-1)(state, view.dispatch) || view.dispatch(state.tr.delete(head - 1, head));
    case "Delete": return codeDelete(1)(state, view.dispatch) || view.dispatch(state.tr.delete(head, head + 1));
    default:
      // not handled: the browser puts the character in, with the marks the caret carries
      if (!typeInCode(view, key)) view.dispatch(state.tr.insertText(key));
  }
}

const fails = [];
for (const [src, keys, want] of CASES) {
  const { text, from, to, inside } = marked(src);
  const doc = T.doc.create(null, T.block.create({ id: "b" }, T.line.create(null, parseInline(text))));
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 2 + from, 2 + to) });
  // a caret inside code at its end, or at its start, is not where it is by itself
  if (from === to) {
    const natural = state.selection.$head.marks().some((m) => m.type === CODE);
    if (inside !== natural) state = state.apply(state.tr.setStoredMarks(inside ? [CODE.create()] : []));
  }
  const view = { get state() { return state; }, dispatch: (tr) => { state = state.apply(tr); } };
  for (const k of keys) press(view, k);
  const got = show(state);
  if (got !== want) fails.push(`${src} typed ${keys.join(" ")}: ${got}, want ${want}`);
}

// A selection in a code block, and Escape out of one: [outline (the code
// block's one line with the caret or selection marked), keys, outline
// afterwards, what is selected, or the text of the line the caret is in]
const BLOCKS = [
  ["- ```\n  f [x] y\n  ```", ["("], "- ```\n  f (x) y\n  ```", "x"],
  ["- ```\n  f [x] y\n  ```", ["[", "("], "- ```\n  f [(x)] y\n  ```", "x"],
  ["- ```\n  f [x]\n  ```", ["`"], "- ```\n  f `\n  ```", "f `"], // typed over, as any character
  // Escape: to the line after the block, or a new one
  ["- ```\n  a|\n  ```\n- next", ["Escape"], "- ```\n  a\n  ```\n- next", "next"],
  ["- ```\n  a|\n  ```\n  - child\n- next", ["Escape"], "- ```\n  a\n  ```\n  - child\n- next", "child"],
  ["- ```\n  a|\n  ```", ["Escape"], "- ```\n  a\n  ```\n- ", ""],
];
for (const [src, keys, want, wantSel] of BLOCKS) {
  const doc = parseOutline(src.replace(/[|[\]]/g, ""));
  const code = src.split("\n")[1].slice(2); // the code block's one line, with its marks
  const a = code.search(/[|[]/), b = code.includes("]") ? code.indexOf("]") - 1 : a;
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 2 + a, 2 + b) }); // doc > block > codeblock
  const view = { get state() { return state; }, dispatch: (tr) => { state = state.apply(tr); } };
  for (const k of keys) press(view, k);
  const got = serializeOutline(state.doc);
  const sel = state.selection.$from.parent.textContent;
  const selected = state.selection.empty ? sel : state.doc.textBetween(state.selection.from, state.selection.to);
  if (got !== want || selected !== wantSel) fails.push(`${JSON.stringify(src)} typed ${keys.join(" ")}: ${JSON.stringify(got)} (${JSON.stringify(selected)}), want ${JSON.stringify(want)} (${JSON.stringify(wantSel)})`);
}

for (const f of fails) console.log(f);
console.log(fails.length ? `${fails.length} of ${CASES.length + BLOCKS.length} code cases failed` : `${CASES.length + BLOCKS.length} code cases`);
process.exitCode = fails.length ? 1 : 0;
