import { schema } from "./schema.js";
import { parseMath, serializeMath } from "./latex.js";

// Text form of an outline, handed to the publisher:
//
//   - TODO read $\frac{a}{b}$ **carefully** DEADLINE: <2026-10-30>
//     difficulty:: medium
//     - child block
//
// Property lines (`name:: value`) sit under their block, one level deeper.
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

const linkText = (node) => {
  const title = resolver.title(node.attrs.page);
  if (!node.attrs.tag) return `[[${title}]]`;
  return TAG_RE.test(title) ? `#${title}` : `#[[${title}]]`;
};

export function serializeInline(fragment) {
  let s = "";
  fragment.forEach((n) => {
    if (n.isText) {
      let t = n.text;
      if (n.marks.some((m) => m.type === schema.marks.em)) t = `*${t}*`;
      if (n.marks.some((m) => m.type === schema.marks.strong)) t = `**${t}**`;
      s += t;
    } else if (n.type === T.math) {
      s += "$" + serializeMath(n.content) + "$";
    } else if (n.type === T.link) {
      s += linkText(n);
    } else if (n.type === T.ref) {
      s += `((${n.attrs.block}))`;
    } else if (n.type === T.image) {
      s += `![${n.attrs.alt}](images/${n.attrs.src})`;
    }
  });
  return s;
}

export function blockLine(block, depth) {
  const { task, deadline } = block.attrs;
  let line = "  ".repeat(depth) + "- ";
  if (task) line += task.toUpperCase() + " ";
  line += serializeInline(block.firstChild.content);
  if (deadline) line += ` DEADLINE: <${deadline}>`;
  return line;
}

// Also takes partial content (a clipboard slice): a block cut open at the
// start may have no line of its own, and then only its children are written.
export function serializeOutline(doc) {
  const lines = [];
  const walk = (fragment, depth) => fragment.forEach((n) => {
    if (n.type === T.line) lines.push("  ".repeat(depth) + "- " + serializeInline(n.content));
    else if (n.type === T.block && n.firstChild?.type === T.line) {
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

// $..$ formulas, **bold**, *italic* (no nesting of marks),
// [[page]], #page, #[[page with spaces]], ((block-id)), ![alt](images/<file>)
export function parseInline(text) {
  const out = [];
  const re = new RegExp(String.raw`!\[([^\]]*)\]\(images\/([^)\s]+)\)|\$([^$]*)\$|\*\*([^*]+)\*\*|\*([^*]+)\*|(#)?\[\[([^\]]+)\]\]|#([^${TAG_STOP}]+)|\(\(([a-z0-9]+)\)\)`, "g");
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(schema.text(text.slice(last, m.index)));
    if (m[2] !== undefined) out.push(T.image.create({ alt: m[1], src: m[2] }));
    else if (m[3] !== undefined) out.push(T.math.create(null, parseMath(m[3])));
    else if (m[4] !== undefined) out.push(schema.text(m[4], [schema.marks.strong.create()]));
    else if (m[5] !== undefined) out.push(schema.text(m[5], [schema.marks.em.create()]));
    else if (m[7] !== undefined) out.push(T.link.create({ page: resolver.pageId(m[7]), tag: !!m[6] }));
    else if (m[8] !== undefined) out.push(T.link.create({ page: resolver.pageId(m[8]), tag: true }));
    else out.push(T.ref.create({ block: m[9] }));
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
  for (const raw of src.split("\n")) {
    const p = !raw.trimStart().startsWith("- ") && PROP.exec(raw);
    if (p) {
      if (last) last.props[resolver.fieldId(p[1])] = p[2];
      continue;
    }
    const m = LINE.exec(raw);
    if (!m) continue;
    const depth = m[1].length >> 1;
    const item = { task: m[2]?.toLowerCase() ?? null, text: m[3], deadline: m[4] ?? null, props: {}, children: [] };
    last = item;
    while (stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].item.children.push(item);
    stack.push({ depth, item });
  }
  const build = (it) =>
    T.block.create(
      { id: newId(), task: it.task, deadline: it.deadline, props: it.props },
      [T.line.create(null, parseInline(it.text)), ...it.children.map(build)],
    );
  if (root.children.length === 0) return emptyDoc();
  return T.doc.create(null, root.children.map(build));
}

export const emptyDoc = () => T.doc.create(null, T.block.create({ id: newId() }, T.line.create()));
