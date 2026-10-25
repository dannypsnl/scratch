// The \ menu: a name finds its command, and a family's name ("arrow") lists
// every member, the common ones first in the order specs.js writes them.
import { ENTRIES, ranked } from "../src/palette.js";

const names = (q) => ranked(ENTRIES, q).map((e) => e.name);
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const arrows = names("arrow");
const common = ["to", "rightarrow", "leftarrow", "leftrightarrow", "mapsto", "Rightarrow", "iff", "hookrightarrow", "rightarrowtail", "twoheadrightarrow", "pfun"];
check(arrows.slice(0, common.length).join() === common.join(), `arrow starts with ${arrows.slice(0, common.length).join(" ")}`);
for (const n of ["gets", "longmapsto", "leadsto", "Longleftrightarrow", "rightharpoonup", "multimap", "nearrow", "xmapsto", "overrightarrow", "pfun"])
  check(arrows.includes(n), `arrow lacks \\${n}`);
for (const n of ["alpha", "frac", "sum", "le"]) check(!arrows.includes(n), `arrow lists \\${n}`);
check(arrows.length > 70, `only ${arrows.length} arrows`);
check(arrows.indexOf("longmapsto") < arrows.indexOf("leadsto"), "KaTeX's own arrows before the AMS ones (among those not named arrow)");
check(new Set(arrows).size === arrows.length, "an arrow listed twice");

check(names("maps")[0] === "mapsto", `maps finds ${names("maps")[0]}`);
check(names("to")[0] === "to", `to finds ${names("to")[0]}`);
check(names("fr").length <= 8, "a plain query is cut to 8");
check(names("").length === 8, "the empty query is cut to 8");

console.log(`palette: ${fails.length} problems`);
for (const f of fails) console.log("  " + f);
if (fails.length) process.exitCode = 1;
