import { Schema, DOMSerializer } from "prosemirror-model";
import { SYMBOLS, STRUCTS, structSpec } from "./specs.js";
import { t } from "./i18n.js";

// Links point at ids; what they display is looked up at render time.
// main.js wires these to the store.
export const lookup = {
  title: (pageId) => pageId,
  line: (_blockId) => null, // the referenced block's line node
};

let refDepth = 0;

// A page is an outline: every block is one line (no line breaks, no headings)
// plus nested child blocks. Indentation is the only structure on offer. The
// one exception is a code block, which takes the line's place and keeps its
// line breaks.
//
// Everything inside a formula is structure: text runs, symbol atoms,
// struct (any \cmd{..}{..}), sup and sub. There is no "raw LaTeX" node.
export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    block: {
      content: "(line | codeblock) block*",
      attrs: {
        id: { default: null },
        task: { default: null }, // null | "todo" | "doing" | "done"
        log: { default: [] }, // [{ state, at }] every task state change
        deadline: { default: null }, // "YYYY-MM-DD"
        folded: { default: false }, // children hidden
        props: { default: {} }, // field id -> value (fields are defined on tag pages)
      },
      toDOM: (node) => [
        "div",
        { class: "pm-block", "data-task": node.attrs.task ?? "", "data-folded": node.attrs.folded ? "true" : "false" },
        ["span", { class: "pm-bullet", contenteditable: "false" }],
        ["div", { class: "pm-body" }, 0],
      ],
    },
    line: {
      content: "inline*",
      marks: "strong em underline strike highlight code",
      toDOM: () => ["div", { class: "pm-line" }, 0],
    },
    // ```lang: plain text with line breaks, no formulas, links or marks
    codeblock: {
      content: "text*",
      marks: "",
      code: true,
      defining: true,
      attrs: { lang: { default: "" } },
      toDOM: (node) => ["pre", { class: "pm-code", "data-lang": node.attrs.lang }, ["code", 0]],
    },
    text: { group: "inline mathinline" },
    // [[page]] or #page (same thing, different look); page is a page id
    link: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { page: {}, tag: { default: false } },
      toDOM: (node) => [
        "span",
        { class: node.attrs.tag ? "pm-link pm-tag" : "pm-link", "data-page": node.attrs.page, contenteditable: "false" },
        (node.attrs.tag ? "#" : "") + lookup.title(node.attrs.page),
      ],
    },
    // an image, by content-hash file name ("<sha256>.png"); drawn by a node
    // view in editor.js that loads it from the local store or the server.
    // width: px it is drawn at (null: its own size, up to the column's)
    image: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { src: {}, alt: { default: "" }, width: { default: null } },
      toDOM: (node) => ["img", { class: "pm-image", alt: node.attrs.alt, "data-src": node.attrs.src, ...(node.attrs.width ? { width: node.attrs.width } : {}) }],
    },
    // ((block)): shows the referenced block's line, read-only. No longer
    // created anywhere; kept so notes that already contain one still load.
    ref: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { block: {} },
      toDOM: (node) => {
        const dom = document.createElement("span");
        dom.className = "pm-ref";
        dom.dataset.block = node.attrs.block;
        dom.contentEditable = "false";
        const line = lookup.line(node.attrs.block);
        if (!line) dom.textContent = t("ref.missing");
        else if (refDepth > 0) dom.textContent = line.textContent; // no refs inside refs
        else {
          refDepth++;
          try { dom.append(DOMSerializer.fromSchema(schema).serializeFragment(line.content)); }
          finally { refDepth--; }
        }
        return dom;
      },
    },
    math: {
      group: "inline",
      inline: true,
      content: "mathinline*",
      marks: "",
      toDOM: () => ["span", { class: "pm-math" }, 0],
    },
    sym: {
      group: "mathinline",
      inline: true,
      atom: true,
      attrs: { name: {} },
      toDOM: (node) => {
        const s = SYMBOLS[node.attrs.name];
        if (!s) return ["span", { class: "pm-sym pm-unknown" }, "\\" + node.attrs.name];
        return ["span", { class: `pm-sym pm-${s.cls}${s.italic ? " pm-italic" : ""}${s.bb ? " pm-bb" : ""}${s.ams ? " pm-ams" : ""}` }, s.char];
      },
    },
    struct: {
      group: "mathinline",
      inline: true,
      attrs: { name: {} },
      content: "slot+",
      toDOM: (node) => {
        const { layout } = structSpec(node.attrs.name, node.childCount);
        const spec = STRUCTS[node.attrs.name];
        const cls = `pm-struct layout-${layout}${spec?.small ? " pm-small" : ""}${spec?.stretchy ? ` pm-st pm-st-${node.attrs.name}` : ""}`;
        const deco = (text) => ["span", { class: "pm-deco", contenteditable: "false" }, text];
        switch (layout) {
          case "radical":
            return ["span", { class: cls }, deco("√"), ["span", { class: "pm-args" }, 0]];
          case "delim":
            // drawn by CSS as tall as what they hold (style.css)
            return ["span", { class: `${cls} pm-delim-${spec.shape}` }, deco(""), ["span", { class: "pm-args" }, 0], deco("")];
          case "binom":
            return ["span", { class: cls }, deco("("), ["span", { class: "pm-args" }, 0], deco(")")];
          case "accent":
            // the mark over the argument (a stretchy one drawn by its class)
            return ["span", { class: `${cls} pm-accent-${node.attrs.name}` }, deco(spec.accent ?? ""), ["span", { class: "pm-args" }, 0]];
          case "accent-under":
            return ["span", { class: cls }, ["span", { class: "pm-args" }, 0], deco("")];
          case "generic":
            return ["span", { class: cls }, deco("\\" + node.attrs.name), ["span", { class: "pm-args" }, 0]];
          default:
            return ["span", { class: cls }, 0];
        }
      },
    },
    slot: {
      inline: true,
      content: "mathinline*",
      marks: "",
      toDOM: () => ["span", { class: "pm-slot" }, 0],
    },
    sup: {
      group: "mathinline",
      inline: true,
      content: "mathinline*",
      marks: "",
      toDOM: () => ["span", { class: "pm-sup" }, 0],
    },
    sub: {
      group: "mathinline",
      inline: true,
      content: "mathinline*",
      marks: "",
      toDOM: () => ["span", { class: "pm-sub" }, 0],
    },
  },
  marks: {
    strong: { toDOM: () => ["strong", 0], parseDOM: [{ tag: "strong" }, { tag: "b" }] },
    em: { toDOM: () => ["em", 0], parseDOM: [{ tag: "em" }, { tag: "i" }] },
    underline: { toDOM: () => ["u", 0], parseDOM: [{ tag: "u" }, { tag: "ins" }] },
    strike: { toDOM: () => ["s", 0], parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }] },
    highlight: { toDOM: () => ["mark", 0], parseDOM: [{ tag: "mark" }] },
    // `inline code`: ` starts it, ` or Escape leaves it (code.js)
    code: { excludes: "_", toDOM: () => ["code", { class: "pm-icode" }, 0], parseDOM: [{ tag: "code" }] },
  },
});

const MATH_TYPES = new Set(["math", "slot", "sup", "sub", "struct"]);
export const isMathy = (type) => MATH_TYPES.has(type.name);
// Nodes whose content holds a caret directly (text-level containers inside formulas).
export const isMathContainer = (type) => ["math", "slot", "sup", "sub"].includes(type.name);
