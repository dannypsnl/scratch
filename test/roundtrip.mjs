import { parseMath, serializeMath } from "../src/latex.js";
import { parseOutline, serializeOutline, resolver } from "../src/outline-io.js";

// links: titles <-> ids through a fixed table
const titles = new Map([["p-1", "topology"], ["p-2", "algebraic topology"], ["p-3", "Mac Lane"], ["2026-10-23", "2026-10-23"]]);
const ids = new Map([...titles].map(([id, t]) => [t, id]));
resolver.title = (id) => titles.get(id) ?? id.replace(/^\?/, ""); // "?name": a page not created yet
resolver.pageId = (t) => ids.get(t) ?? "?" + t;
// fields: names <-> ids the same way
const fieldNames = new Map([["f-1", "difficulty"], ["f-2", "paper"]]);
const fieldIds = new Map([...fieldNames].map(([id, n]) => [n, id]));
resolver.fieldName = (id) => fieldNames.get(id) ?? id;
resolver.fieldId = (n) => fieldIds.get(n) ?? n;
import { Fragment } from "prosemirror-model";

// Canonical inputs must survive parse -> serialize unchanged.
const canonical = [
  "x",
  "\\frac{a+b}{2}\\geq\\sqrt{ab}",
  "e^{i\\pi}+1=0",
  "x_i^2",
  "\\sum_{k=0}^nk",
  "\\xrightarrow{f}",
  "\\xleftarrow[g]{f}", // an \\overset over an \\underset over the arrow
  "\\sqrt[3]{x}",
  "\\foo{x}{y}",
  "\\foo{}",
  "\\unknownsym x",
  "\\mathbb{R}^n",
  "\\{x\\}",
  "a^{\\alpha}",
  "a\\,b\\quad c", // spacing is kept
  "\\text{if and only if}",
];

// Non-canonical inputs and the form they normalize to.
const normalizing = [
  ["\\frac 1 2", "\\frac{1}{2}"],
  ["x^{2}", "x^2"],
  ["\\alpha  x", "\\alpha x"],
  ["{a}{b}", "ab"],
  ["\\overset{f}{\\to}", "\\xrightarrow{f}"], // written so that it stretches
  ["a\\\\b", "ab"], // a line break means nothing in an inline formula
];

let fail = 0;
const check = (input, want) => {
  const got = serializeMath(Fragment.fromArray(parseMath(input)));
  if (got !== want) { fail++; console.log(`FAIL  ${JSON.stringify(input)}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};
for (const s of canonical) check(s, s);
for (const [s, w] of normalizing) check(s, w);

const outlineSrc = [
  "- TODO prove $\\frac{a+b}{2}\\geq\\sqrt{ab}$ DEADLINE: <2026-10-30>",
  "  - start with $n=2$, using **bold** and *italic*",
  "    - one level deeper",
  "- DONE finished",
  "- no state $x_i^2$",
  "- ![board](images/0f343b0931126a20f133d67c2b018a3b8b2b8f0e2e0d8b6b8c6d3c2a1b0c9d8e.png)",
  "- read [[Mac Lane]], #topology, #[[algebraic topology]], see ((abc123)) and [[2026-10-23]]",
  "- fold a crane #origami",
  "  difficulty:: medium",
  "  paper:: 15 cm square",
  "  - a child after the properties",
  "- run `npm test` before $a$, not `$x$` or `#tag`",
  "- ```js",
  "  let x = 1",
  "",
  "    indented();",
  "  ```",
  "  - a child of the code block",
  "  - TODO ```",
  "    ```",
].join("\n");
const outlineOut = serializeOutline(parseOutline(outlineSrc));
if (outlineOut !== outlineSrc) { fail++; console.log("FAIL outline\n" + outlineOut); }

const total = canonical.length + normalizing.length + 1;
console.log(fail ? `${fail}/${total} failed` : `all ${total} passed`);
process.exit(fail ? 1 : 0);
