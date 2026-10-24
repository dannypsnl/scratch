// Every command the editor knows: its LaTeX survives a parse and a write
// unchanged, and KaTeX (the publisher) renders it. The user's own macros
// (\Z, \Hom, …) are not KaTeX's and only get the round trip.
import katex from "katex";
import { schema } from "../src/schema.js";
import { SYMBOLS, STRUCTS, X_ARROWS } from "../src/specs.js";
import { parseMath, serializeMath } from "../src/latex.js";

const MACROS = new Set(["N", "Z", "Q", "R", "C", "F", "P", "rank", "hom", "Hom", "End", "Aut", "id", "im", "coker", "lcm", "tr", "cosec", "cotg", "arcctg"]);
const write = (tex) => serializeMath(schema.nodes.math.create(null, parseMath(tex)).content);

const cases = [
  ...Object.keys(SYMBOLS).map((name) => [name, `a\\${name} b`]),
  ...Object.entries(STRUCTS).filter(([name]) => name !== "root").map(([name, s]) => [name, `\\${name}` + ["{x}", "{y}", "{z}"].slice(0, s.arity).join("")]),
  ["root", "\\sqrt[x]{y}"],
  // labelled arrows, with and without a label below
  ...Object.keys(X_ARROWS).flatMap((name) => [[name, `\\${name}{x}`], [name, `\\${name}[y]{x}`]]),
  ["text", "\\text{long label}"],
  ["texttt", "\\texttt{a b}"],
  ["thin space", "a\\,b\\:c\;d\\!e\\quad f"],
];

const fails = [];
for (const [name, tex] of cases) {
  const once = write(tex), twice = write(once);
  if (once !== twice) fails.push(`${name}: ${tex} -> ${once} -> ${twice}`);
  if (once.replace(/\s+/g, "") !== tex.replace(/\s+/g, "") && !STRUCTS[name]?.text) fails.push(`${name}: ${tex} written as ${once}`);
  if (STRUCTS[name]?.text && once !== tex) fails.push(`${name}: ${tex} written as ${once} (spaces lost?)`);
  if (MACROS.has(name)) continue;
  try { katex.renderToString(once, { throwOnError: true, strict: "ignore" }); }
  catch (e) { fails.push(`${name}: KaTeX cannot render ${once}: ${e.message.split("\n")[0]}`); }
}
console.log(`${cases.length} commands, ${fails.length} problems`);
for (const f of fails) console.log("  " + f);
if (fails.length) process.exitCode = 1;
