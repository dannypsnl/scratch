import { schema } from "./schema.js";
import { parseMath, serializeMath } from "./latex.js";

// Text form of an outline, handed to the publisher:
//
//   - TODO read $\frac{a}{b}$ **carefully** #reading DEADLINE: <2026-10-30>
//     difficulty:: medium
//     - child block
//
// A block's tags are written after its line; read, a #tag anywhere in the
// line is the block's.
// Property lines (`name:: value`) sit under their block, one level deeper.
// A code block is a fence whose body is indented one level deeper:
//
//   - ```js
//     let x = 1
//     ```
//
// Block ids and the task log are database-only; they are not exported.

const T = schema.nodes;
export const newId = () => Math.random().toString(36).slice(2, 10);

// Links are stored by page id but exported by title. main.js wires this to
// the store; pageId(title) finds or creates the page.
export const resolver = {
  title: (id) => id,
  pageId: (title) => title,
  fieldName: (id) => id,
  fieldId: (name) => name,
};

// characters that end a bare #tag
const TAG_STOP = "\\s#[\\]$*(),.;:!?，。、；：！？「」（）";
const TAG_RE = new RegExp(`^[^${TAG_STOP}]+$`);

export const tagText = (page) => {
  const title = resolver.title(page);
  return TAG_RE.test(title) ? `#${title}` : `#[[${title}]]`;
};
// " #a #[[b c]]", or "" for a block without tags
export const tagsText = (block) => block.attrs.tags.map((p) => " " + tagText(p)).join("");

export function serializeInline(fragment) {
  let s = "";
  fragment.forEach((n) => {
    if (n.isText) {
      let t = n.text;
      if (n.marks.some((m) => m.type === schema.marks.code)) t = "`" + t + "`";
      if (n.marks.some((m) => m.type === schema.marks.em)) t = `*${t}*`;
      if (n.marks.some((m) => m.type === schema.marks.underline)) t = `<u>${t}</u>`;
      if (n.marks.some((m) => m.type === schema.marks.strike)) t = `~~${t}~~`;
      if (n.marks.some((m) => m.type === schema.marks.highlight)) t = `==${t}==`;
      if (n.marks.some((m) => m.type === schema.marks.strong)) t = `**${t}**`;
      s += t;
    } else if (n.type === T.math) {
      s += "$" + serializeMath(n.content) + "$";
    } else if (n.type === T.link) {
      s += `[[${resolver.title(n.attrs.page)}]]`;
    } else if (n.type === T.ref) {
      s += `((${n.attrs.block}))`;
    } else if (n.type === T.image) {
      s += `![${n.attrs.alt}${n.attrs.width ? `|${n.attrs.width}` : ""}](images/${n.attrs.src})`;
    }
  });
  return s;
}

const fenced = (code, depth) => {
  const pad = "  ".repeat(depth + 1);
  return ["```" + code.attrs.lang, ...(code.textContent ? code.textContent.split("\n") : []).map((l) => (l ? pad + l : "")), pad + "```"].join("\n");
};

export function blockLine(block, depth) {
  const { task, deadline } = block.attrs;
  const first = block.firstChild;
  let line = "  ".repeat(depth) + "- ";
  if (task) line += task.toUpperCase() + " ";
  if (first.type === T.codeblock) {
    // the deadline stays on the fence line, where the parser looks for it
    const [fence, ...body] = fenced(first, depth).split("\n");
    return [line + fence + tagsText(block) + (deadline ? ` DEADLINE: <${deadline}>` : ""), ...body].join("\n");
  }
  const text = serializeInline(first.content);
  line += text ? text + tagsText(block) : tagsText(block).slice(1);
  if (deadline) line += ` DEADLINE: <${deadline}>`;
  return line;
}

// Also takes partial content (a clipboard slice): a block cut open at the
// start may have no line of its own, and then only its children are written.
export function serializeOutline(doc) {
  const lines = [];
  const walk = (fragment, depth) => fragment.forEach((n) => {
    if (n.type === T.line) lines.push("  ".repeat(depth) + "- " + serializeInline(n.content));
    else if (n.type === T.codeblock) lines.push("  ".repeat(depth) + "- " + fenced(n, depth));
    else if (n.type === T.block && (n.firstChild?.type === T.line || n.firstChild?.type === T.codeblock)) {
      lines.push(blockLine(n, depth));
      for (const [field, value] of Object.entries(n.attrs.props ?? {})) {
        lines.push("  ".repeat(depth + 1) + `${resolver.fieldName(field)}:: ${value}`);
      }
      walk(n.content.cut(n.firstChild.nodeSize), depth + 1);
    } else if (n.type === T.block) walk(n.content, depth);
  });
  walk(doc.content, 0);
  return lines.join("\n");
}

// `code`, $..$ formulas, **bold**, *italic*, <u>underline</u>, ~~strike~~,
// ==highlight== (no nesting of marks),
// [[page]], ((block-id)), ![alt](images/<file>) (![alt|300](…): drawn 300px
// wide). #page and #[[page with spaces]] go into `tags` (page ids), the
// spaces around them closing up; without `tags` they stay text.
export function parseInline(text, tags = null) {
  const out = [];
  const re = new RegExp(String.raw`\x60([^\x60]+)\x60|!\[([^\]]*)\]\(images\/([^)\s]+)\)|\$([^$]*)\$|\*\*([^*]+)\*\*|\*([^*]+)\*|<u>(.+?)<\/u>|~~([^~]+)~~|==([^=]+)==|(#)?\[\[([^\]]+)\]\]|#([^${TAG_STOP}]+)|\(\(([a-z0-9]+)\)\)`, "g");
  let last = 0, m;
  while ((m = re.exec(text))) {
    const tag = m[10] ? m[11] : m[12];
    if (tag !== undefined && !tags) continue;
    let before = text.slice(last, m.index);
    if (tag !== undefined) {
      tags.push(resolver.pageId(tag));
      // a space either side (or the line's start before): the ones before go
      const after = re.lastIndex;
      if (after >= text.length || /\s/.test(text[after])) {
        if (/\s$/.test(before) || (!before && !out.length)) {
          before = before.replace(/\s+$/, "");
          if (!before && !out.length) re.lastIndex = after + /^\s*/.exec(text.slice(after))[0].length;
        }
      }
      if (before) out.push(schema.text(before));
      last = re.lastIndex;
      continue;
    }
    if (before) out.push(schema.text(before));
    if (m[1] !== undefined) out.push(schema.text(m[1], [schema.marks.code.create()]));
    else if (m[3] !== undefined) {
      const [, alt, width] = /^(.*?)(?:\|(\d+))?$/.exec(m[2]);
      out.push(T.image.create({ alt, src: m[3], width: width ? Number(width) : null }));
    }
    else if (m[4] !== undefined) out.push(T.math.create(null, parseMath(m[4])));
    else if (m[5] !== undefined) out.push(schema.text(m[5], [schema.marks.strong.create()]));
    else if (m[6] !== undefined) out.push(schema.text(m[6], [schema.marks.em.create()]));
    else if (m[7] !== undefined) out.push(schema.text(m[7], [schema.marks.underline.create()]));
    else if (m[8] !== undefined) out.push(schema.text(m[8], [schema.marks.strike.create()]));
    else if (m[9] !== undefined) out.push(schema.text(m[9], [schema.marks.highlight.create()]));
    else if (m[11] !== undefined) out.push(T.link.create({ page: resolver.pageId(m[11]) }));
    else out.push(T.ref.create({ block: m[13] }));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(schema.text(text.slice(last)));
  return out;
}

const LINE = /^( *)- (?:(TODO|DOING|DONE) )?(.*?)(?: DEADLINE: <(\d{4}-\d\d-\d\d)>)?$/;
const PROP = /^ *([^\s-][^:]*?):: (.*)$/;

export function parseOutline(src) {
  const root = { children: [] };
  const stack = [{ depth: -1, item: root }];
  let last = null;
  let fence = null; // { item, pad }: inside a code block's body
  for (const raw of src.split("\n")) {
    if (fence) {
      if (raw.trim() === "```") fence = null;
      else fence.item.code.push(raw.startsWith(fence.pad) ? raw.slice(fence.pad.length) : raw.trimStart());
      continue;
    }
    const p = !raw.trimStart().startsWith("- ") && PROP.exec(raw);
    if (p) {
      if (last) last.props[resolver.fieldId(p[1])] = p[2];
      continue;
    }
    const m = LINE.exec(raw);
    if (!m) continue;
    const depth = m[1].length >> 1;
    const item = { task: m[2]?.toLowerCase() ?? null, deadline: m[4] ?? null, props: {}, tags: [], children: [] };
    last = item;
    // a fence line keeps its tags after the language
    const open = /^```(\S*)((?: #(?:\[\[[^\]]+\]\]|\S+))*)$/.exec(m[3]);
    if (open) parseInline(open[2], item.tags);
    else item.line = T.line.create(null, parseInline(m[3], item.tags));
    if (open) {
      item.lang = open[1];
      item.code = [];
      fence = { item, pad: "  ".repeat(depth + 1) };
    }
    while (stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].item.children.push(item);
    stack.push({ depth, item });
  }
  const build = (it) =>
    T.block.create(
      { id: newId(), task: it.task, deadline: it.deadline, props: it.props, tags: it.tags },
      [it.code ? T.codeblock.create({ lang: it.lang }, it.code.length ? schema.text(it.code.join("\n")) : null) : it.line, ...it.children.map(build)],
    );
  if (root.children.length === 0) return emptyDoc();
  return T.doc.create(null, root.children.map(build));
}

export const emptyDoc = () => T.doc.create(null, T.block.create({ id: newId() }, T.line.create()));
