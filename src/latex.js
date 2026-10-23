import { schema } from "./schema.js";
import { SYMBOLS, STRUCTS } from "./specs.js";

// ---------- LaTeX -> nodes ----------

const ESCAPABLE = "{}#%&$_^";

// Parse a formula body (no surrounding $) into an array of mathinline nodes.
export function parseMath(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };

  function readCommand() {
    // at '\'
    i++;
    if (i < src.length && !/[a-zA-Z]/.test(src[i])) {
      const c = src[i++];
      return ESCAPABLE.includes(c) ? [c] : []; // \{ -> "{" ; \, \; \\ etc -> dropped
    }
    let name = "";
    while (i < src.length && /[a-zA-Z]/.test(src[i])) name += src[i++];
    if (SYMBOLS[name]) return [schema.nodes.sym.create({ name })];
    const slots = [];
    if (STRUCTS[name]) {
      for (let k = 0; k < STRUCTS[name].arity; k++) slots.push(parseArg());
    } else {
      for (;;) {
        const save = i;
        ws();
        if (src[i] !== "{") { i = save; break; }
        slots.push(parseArg());
      }
      if (slots.length === 0) return [schema.nodes.sym.create({ name })];
    }
    return [schema.nodes.struct.create({ name }, slots.map((c) => schema.nodes.slot.create(null, c)))];
  }

  function parseArg() {
    ws();
    if (src[i] === "{") {
      i++;
      const inner = parseSeq(true);
      if (src[i] === "}") i++;
      return inner;
    }
    if (src[i] === "\\") return normalize(readCommand());
    if (i < src.length) return normalize([src[i++]]);
    return [];
  }

  function parseSeq(inGroup) {
    const out = [];
    while (i < src.length) {
      const c = src[i];
      if (c === "}") { if (inGroup) break; i++; continue; }
      if (c === "{") { i++; out.push(...parseSeq(true)); if (src[i] === "}") i++; continue; }
      if (c === "^" || c === "_") {
        i++;
        const type = c === "^" ? schema.nodes.sup : schema.nodes.sub;
        out.push(type.create(null, parseArg()));
        continue;
      }
      if (c === "\\") { out.push(...readCommand()); continue; }
      if (/\s/.test(c)) { i++; continue; }
      out.push(c);
      i++;
    }
    return normalize(out);
  }

  return parseSeq(false);
}

// strings -> merged text nodes
function normalize(items) {
  const out = [];
  let buf = "";
  for (const it of items) {
    if (typeof it === "string") buf += it;
    else {
      if (buf) { out.push(schema.text(buf)); buf = ""; }
      out.push(it);
    }
  }
  if (buf) out.push(schema.text(buf));
  return out;
}

// ---------- nodes -> LaTeX ----------

class Out {
  constructor() { this.s = ""; }
  emit(str) {
    if (/\\[a-zA-Z]+$/.test(this.s) && /^[a-zA-Z]/.test(str)) this.s += " ";
    this.s += str;
  }
}

export function serializeMath(fragment) {
  const out = new Out();
  writeFragment(fragment, out);
  return out.s;
}

function writeFragment(fragment, out) {
  fragment.forEach((node) => {
    switch (node.type.name) {
      case "text":
        out.emit([...node.text].map((c) => (ESCAPABLE.includes(c) ? "\\" + c : c)).join(""));
        break;
      case "sym":
        out.emit("\\" + node.attrs.name);
        break;
      case "struct":
        out.emit("\\" + node.attrs.name);
        node.forEach((slot) => out.emit("{" + serializeMath(slot.content) + "}"));
        break;
      case "sup":
      case "sub": {
        const body = serializeMath(node.content);
        out.emit((node.type.name === "sup" ? "^" : "_") + (isSingleToken(node) ? body : "{" + body + "}"));
        break;
      }
    }
  });
}

function isSingleToken(node) {
  if (node.childCount !== 1) return false;
  const c = node.firstChild;
  return c.isText && c.text.length === 1 && !ESCAPABLE.includes(c.text);
}
