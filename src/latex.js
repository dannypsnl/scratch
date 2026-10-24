import { schema } from "./schema.js";
import { SYMBOLS, STRUCTS, X_ARROWS, ARROW_X } from "./specs.js";

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
      if (ESCAPABLE.includes(c)) return [c]; // \{ -> "{"
      if (SYMBOLS[c]) return [schema.nodes.sym.create({ name: c })]; // \, \: \; \! spacing
      return []; // \\ and the like: dropped
    }
    let name = "";
    while (i < src.length && /[a-zA-Z]/.test(src[i])) name += src[i++];
    if (SYMBOLS[name]) return [schema.nodes.sym.create({ name })];
    const S = schema.nodes, slot = (c) => S.slot.create(null, c);
    // \sqrt[n]{x}: the index a slot of its own
    if (name === "sqrt") {
      const index = parseOptional();
      if (index) return [S.struct.create({ name: "root" }, [slot(index), slot(parseArg())])];
    }
    // \xrightarrow[g]{f}: the \overset it stands for, \overset{f}{\underset{g}{\to}}
    if (X_ARROWS[name]) {
      const below = parseOptional(), above = parseArg(), arrow = S.sym.create({ name: X_ARROWS[name].sym });
      const base = below ? S.struct.create({ name: "underset" }, [slot(below), slot([arrow])]) : arrow;
      return [S.struct.create({ name: "overset" }, [slot(above), slot([base])])];
    }
    const slots = [];
    if (STRUCTS[name]?.text) {
      for (let k = 0; k < STRUCTS[name].arity; k++) slots.push(parseTextArg());
    } else if (STRUCTS[name]) {
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

  // [ … ] after a command: its optional argument, or null
  function parseOptional() {
    const save = i;
    ws();
    if (src[i] !== "[") { i = save; return null; }
    let depth = 0, k = i + 1;
    for (; k < src.length; k++) {
      if (src[k] === "\\") { k++; continue; }
      if (src[k] === "{") depth++;
      else if (src[k] === "}") depth--;
      else if (src[k] === "]" && depth === 0) break;
    }
    const inner = parseMath(src.slice(i + 1, k));
    i = k + 1;
    return inner;
  }

  // \text{…}: the words as written, spaces kept (\{ \} \\ … unescaped)
  function parseTextArg() {
    ws();
    if (src[i] !== "{") return parseArg();
    i++;
    let depth = 1, text = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\" && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
      if (c === "{") depth++;
      if (c === "}" && --depth === 0) { i++; break; }
      text += c;
      i++;
    }
    return normalize([text].filter(Boolean));
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
      case "struct": {
        const x = xArrow(node);
        if (x) out.emit(`\\${x.name}` + (x.below ? `[${serializeMath(x.below)}]` : "") + `{${serializeMath(x.above)}}`);
        else if (node.attrs.name === "root") out.emit(`\\sqrt[${serializeMath(node.child(0).content)}]{${serializeMath(node.child(1).content)}}`);
        else {
          out.emit("\\" + node.attrs.name);
          node.forEach((slot) => out.emit("{" + serializeMath(slot.content) + "}"));
        }
        break;
      }
      case "sup":
      case "sub": {
        const body = serializeMath(node.content);
        out.emit((node.type.name === "sup" ? "^" : "_") + (isSingleToken(node) ? body : "{" + body + "}"));
        break;
      }
    }
  });
}

// An \overset over a lone arrow is written \xrightarrow{label} (and kin), so
// it stretches wherever the LaTeX goes; over an \underset of one,
// \xrightarrow[below]{above}; an \underset of one alone, \xrightarrow[below]{}.
function xArrow(node) {
  const lone = (slot) => (slot.childCount === 1 ? slot.firstChild : null);
  const arrowName = (n) => (n?.type.name === "sym" ? ARROW_X[n.attrs.name] : null);
  if (node.childCount !== 2) return null;
  const [label, base] = [node.child(0), node.child(1)];
  if (node.attrs.name === "overset") {
    const b = lone(base);
    if (arrowName(b)) return { name: arrowName(b), above: label.content };
    if (b?.type.name === "struct" && b.attrs.name === "underset" && b.childCount === 2 && arrowName(lone(b.child(1))))
      return { name: arrowName(lone(b.child(1))), above: label.content, below: b.child(0).content };
  }
  if (node.attrs.name === "underset" && arrowName(lone(base))) return { name: arrowName(lone(base)), above: base.type.schema.nodes.slot.create().content, below: label.content };
  return null;
}

function isSingleToken(node) {
  if (node.childCount !== 1) return false;
  const c = node.firstChild;
  return c.isText && c.text.length === 1 && !ESCAPABLE.includes(c.text);
}
