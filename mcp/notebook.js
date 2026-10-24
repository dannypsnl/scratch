import { Fragment } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { schema } from "../src/schema.js";
import { readAll, writePage, setTitle, invalidate } from "../src/loro.js";
import { parseOutline, serializeInline, blockLine, emptyDoc, newId, resolver } from "../src/outline-io.js";
import { t } from "../src/i18n.js";

// The notebook as the MCP tools see it: pages read from and written to the
// Loro document (src/loro.js) the way the app does, in the app's text form
// (src/outline-io.js). Every call reads the document afresh, and a write is
// a diff against what was just read (writePage), so it never reverts blocks
// another device changed.
//
// In text handed out, each block line ends with its id, ` ^id`. The same
// suffix in text handed in is dropped; when a block is replaced, ids of its
// own subtree are kept, so references to them ((id)) stay valid.

const T = schema.nodes;
export const isDate = (id) => /^\d{4}-\d\d-\d\d$/.test(id);
export const today = () => new Date().toLocaleDateString("sv");

let pages = new Map(); // page id -> { title, fields, doc }, as last read
function read() {
  invalidate();
  pages = readAll();
  return pages;
}

const titleOf = (id) => {
  if (isDate(id)) return id;
  if (id.startsWith("?")) return id.slice(1); // a link to a page not created yet
  return pages.get(id)?.title ?? t("page.untitled");
};

// A page by its title, a date ("2026-10-24", "2026/10/24") or, with
// `loose`, also "today" and a page id. Journal days need no page to exist.
function findPage(name, loose = false) {
  const s = name.trim();
  if (loose && s.toLowerCase() === "today") return today();
  if (isDate(s)) return s;
  if (isDate(s.replaceAll("/", "-"))) return s.replaceAll("/", "-");
  if (loose && pages.has(s)) return s;
  const key = s.toLowerCase();
  for (const [id, p] of pages) if (!isDate(id) && (p.title ?? t("page.untitled")).toLowerCase() === key) return id;
  return null;
}

const allFields = () => [...pages.values()].flatMap((p) => p.fields ?? []);
resolver.title = titleOf;
resolver.pageId = (title) => findPage(title) ?? "?" + title;
resolver.fieldName = (id) => allFields().find((f) => f.id === id)?.name ?? id;
resolver.fieldId = (name) => allFields().find((f) => f.name === name)?.id ?? name;

const isEmpty = (d) =>
  !d || (d.childCount === 1 && d.firstChild.childCount === 1 &&
  d.firstChild.firstChild.content.size === 0 && !d.firstChild.attrs.task && !d.firstChild.attrs.deadline);

// A journal day with nothing on it has no blocks in Loro, as in the app.
function save(page, before, after) {
  writePage(page, before, isDate(page) && isEmpty(after) ? null : after);
}

function pageOrThrow(name) {
  read();
  const page = findPage(name, true);
  if (!page) throw new Error(`no page named "${name}"; create it with create_page, or use a date or "today" for the journal`);
  return page;
}

function locate(id) {
  read();
  for (const [page, { doc }] of pages) {
    if (!doc) continue;
    let found = null;
    doc.descendants((node, pos) => {
      if (found) return false;
      if (node.type === T.block && node.attrs.id === id) found = { page, doc, pos, node };
      return node.type === T.block;
    });
    if (found) return found;
  }
  throw new Error(`no block with id ${id}`);
}

// ---------- text ----------

const ID = / \^([a-z0-9]{4,12})$/;
const BLOCK_LINE = /^ *- (?:(?:TODO|DOING|DONE) )?(.*)$/;

// Blocks from outline text. Plain lines with no "- " anywhere are taken as
// one top-level block each. `keep` is the set of ids the text may reuse;
// the first block takes `first` unless the text gives it an id.
function parseBlocks(text, keep = new Set(), first = null) {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!lines.some((l) => BLOCK_LINE.test(l))) lines = lines.filter((l) => l.trim()).map((l) => "- " + l.trim());
  const ids = [];
  let fence = null; // inside a code block's body, ids are text
  lines = lines.map((raw) => {
    if (fence) {
      if (raw.trim() === "```") fence = null;
      return raw;
    }
    const m = BLOCK_LINE.exec(raw);
    if (!m) return raw;
    const id = ID.exec(raw);
    const line = id ? raw.slice(0, id.index) : raw;
    ids.push(id?.[1] ?? null);
    if (/^```\S*( DEADLINE: <[^>]*>)?$/.test(BLOCK_LINE.exec(line)[1])) fence = true;
    return line;
  });
  const blocks = [];
  if (!ids.length) return blocks;
  ids[0] ??= first;
  parseOutline(lines.join("\n")).forEach((b) => blocks.push(b));
  let k = 0;
  const withIds = (b) => {
    const want = ids[k++];
    const id = want && keep.delete(want) ? want : b.attrs.id;
    const kids = [];
    b.forEach((c, _, i) => kids.push(i === 0 ? c : withIds(c)));
    return T.block.create({ ...b.attrs, id }, kids);
  };
  return blocks.map(withIds);
}

// The app's text form (serializeOutline), each block line ending in ` ^id`.
export function outlineText(doc) {
  const lines = [];
  const walk = (block, depth) => {
    const [first, ...rest] = blockLine(block, depth).split("\n");
    lines.push(`${first} ^${block.attrs.id}`, ...rest);
    for (const [field, value] of Object.entries(block.attrs.props ?? {})) {
      lines.push("  ".repeat(depth + 1) + `${resolver.fieldName(field)}:: ${value}`);
    }
    block.forEach((c, _, i) => { if (i > 0) walk(c, depth + 1); });
  };
  doc?.forEach((b) => walk(b, 0));
  return lines.join("\n");
}

const lineText = (block) => (block.firstChild.type === T.codeblock ? block.firstChild.textContent : serializeInline(block.firstChild.content));

const idsIn = (node) => {
  const out = [];
  node.descendants((n) => { if (n.type === T.block) out.push(n.attrs.id); return true; });
  return out;
};

// ---------- tools ----------

export function listPages() {
  read();
  const named = [], journal = [];
  for (const [id, p] of pages) {
    if (isDate(id)) { if (!isEmpty(p.doc)) journal.push(id); }
    else named.push({ id, title: p.title ?? t("page.untitled") });
  }
  named.sort((a, b) => a.title.localeCompare(b.title));
  journal.sort().reverse();
  return { pages: named, journal };
}

export function readPage(name) {
  const page = pageOrThrow(name);
  const p = pages.get(page);
  return { id: page, title: titleOf(page), text: isEmpty(p?.doc) && isDate(page) ? "" : outlineText(p?.doc) };
}

// Blocks whose line contains every word of `query` (any case), in their text
// form, so formulas match by their LaTeX and links by the page's title.
// Journal days newest first, then pages by title.
export function search(query, { limit = 30, task = null } = {}) {
  read();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const order = [...pages.keys()].sort((a, b) =>
    isDate(a) !== isDate(b) ? (isDate(a) ? -1 : 1) : isDate(a) ? b.localeCompare(a) : titleOf(a).localeCompare(titleOf(b)));
  const hits = [];
  for (const page of order) {
    const doc = pages.get(page).doc;
    if (!doc) continue;
    const walk = (block, trail) => {
      if (hits.length >= limit) return;
      const text = lineText(block);
      const lower = text.toLowerCase();
      if ((words.length || task) && words.every((w) => lower.includes(w)) && (!task || block.attrs.task === task)) {
        hits.push({ page, title: titleOf(page), id: block.attrs.id, task: block.attrs.task, deadline: block.attrs.deadline, trail, text });
      }
      block.forEach((c, _, i) => { if (i > 0) walk(c, [...trail, text]); });
    };
    doc.forEach((b) => walk(b, []));
  }
  const titles = [...pages.keys()].filter((id) => !isDate(id) && words.length && words.every((w) => titleOf(id).toLowerCase().includes(w)));
  return { pages: titles.map((id) => ({ id, title: titleOf(id) })), blocks: hits };
}

// Links to the page by name ("?title") now point at it, as in the app.
function relink(title, to) {
  const from = "?" + title;
  for (const [page, { doc }] of read()) {
    if (!doc) continue;
    let tr = null;
    doc.descendants((n, pos) => {
      if (n.type === T.link && n.attrs.page === from) {
        tr ??= new Transform(doc);
        tr.setNodeMarkup(pos, null, { ...n.attrs, page: to });
      }
    });
    if (tr) save(page, doc, tr.doc);
  }
}

export function createPage(title, text = "") {
  read();
  const name = title.trim();
  if (!name) throw new Error("a page needs a title");
  if (isDate(name) || isDate(name.replaceAll("/", "-"))) throw new Error(`"${name}" is a journal day: append to it instead`);
  if (findPage(name)) throw new Error(`a page named "${name}" already exists`);
  const id = "p-" + newId();
  setTitle(id, name);
  const blocks = parseBlocks(text);
  writePage(id, null, blocks.length ? T.doc.create(null, blocks) : emptyDoc());
  relink(name, id);
  return { id, title: name, ids: blocks.map((b) => b.attrs.id) };
}

// At the end of a page (a page with one empty block: in its place), or as
// the last children of block `parent`.
export function appendBlocks(name, text, parent = null) {
  if (parent) return insertBlocks(parent, text, "last_child");
  const page = pageOrThrow(name);
  const blocks = parseBlocks(text);
  if (!blocks.length) throw new Error("no blocks in text");
  const before = pages.get(page)?.doc ?? null;
  const after = isEmpty(before)
    ? T.doc.create(null, blocks)
    : new Transform(before).insert(before.content.size, Fragment.fromArray(blocks)).doc;
  save(page, before, after);
  return { page, title: titleOf(page), ids: blocks.map((b) => b.attrs.id) };
}

export function insertBlocks(id, text, position = "after") {
  const at = locate(id);
  const blocks = parseBlocks(text);
  if (!blocks.length) throw new Error("no blocks in text");
  const end = at.pos + at.node.nodeSize;
  const pos = { before: at.pos, after: end, first_child: at.pos + 1 + at.node.firstChild.nodeSize, last_child: end - 1 }[position];
  if (pos === undefined) throw new Error(`position is one of before, after, first_child, last_child`);
  save(at.page, at.doc, new Transform(at.doc).insert(pos, Fragment.fromArray(blocks)).doc);
  return { page: at.page, title: titleOf(at.page), ids: blocks.map((b) => b.attrs.id) };
}

// The block and its children give way to the blocks of `text`; empty text
// deletes them.
export function replaceBlock(id, text) {
  const at = locate(id);
  const blocks = parseBlocks(text, new Set([id, ...idsIn(at.node)]), id);
  let after;
  if (!blocks.length && at.doc.childCount === 1 && at.doc.firstChild === at.node) after = emptyDoc();
  else after = new Transform(at.doc).replaceWith(at.pos, at.pos + at.node.nodeSize, Fragment.fromArray(blocks)).doc;
  save(at.page, at.doc, after);
  return { page: at.page, title: titleOf(at.page), ids: blocks.map((b) => b.attrs.id) };
}

function setAttrs(id, fn) {
  const at = locate(id);
  save(at.page, at.doc, new Transform(at.doc).setNodeMarkup(at.pos, null, fn(at.node.attrs)).doc);
  return { page: at.page, title: titleOf(at.page), id };
}

// As Cmd-Enter in the app: the change is logged with its time.
export function setTask(id, state) {
  if (!["todo", "doing", "done", "none"].includes(state)) throw new Error("state is one of todo, doing, done, none");
  const task = state === "none" ? null : state;
  return setAttrs(id, (a) => ({ ...a, task, log: [...a.log, { state, at: new Date().toISOString() }] }));
}

export function setDeadline(id, date) {
  if (date !== null && !isDate(date)) throw new Error("a deadline is a date, YYYY-MM-DD (or null to clear it)");
  return setAttrs(id, (a) => ({ ...a, deadline: date }));
}
