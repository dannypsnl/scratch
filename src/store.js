import { Fragment } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { schema } from "./schema.js";
import { emptyDoc, newId } from "./outline-io.js";
import { doc, settings, readAll, writePage, setTitle, setFields, invalidate, deletePage as deleteInLoro } from "./loro.js";
import { persistence } from "./persist.js";
import { t } from "./i18n.js";
import { longDate } from "./dates.js";

// Pages are outlines. A page id is either a date ("YYYY-MM-DD", a journal
// day) or "p-…" for a named page. The Loro document (loro.js) is the source of
// truth that is persisted and synced; ProseMirror docs here are the working
// copy every view reads, and queries walk them directly.

const T = schema.nodes;
const journal = new Map(); // date -> doc
const named = new Map(); // id -> { title, doc, fields }
const base = new Map(); // page -> doc as last read from / written to Loro
const dirty = new Set(); // pages edited since the last flush
let meta = {};

export const isDate = (id) => /^\d{4}-\d\d-\d\d$/.test(id);

const isEmpty = (d) =>
  d.childCount === 1 && d.firstChild.childCount === 1 &&
  d.firstChild.firstChild.content.size === 0 && !d.firstChild.attrs.task && !d.firstChild.attrs.deadline;

// ---------- Loro <-> working copy ----------

function rebuild() {
  invalidate();
  const changed = new Set();
  const seen = new Set();
  for (const [page, { title, fields, doc: d }] of readAll()) {
    seen.add(page);
    if (isDate(page)) {
      if (!d) { if (journal.delete(page)) changed.add(page); continue; }
      if (!journal.get(page)?.eq(d)) changed.add(page);
      journal.set(page, d);
    } else {
      const cur = named.get(page);
      const next = { title: title ?? cur?.title ?? t("page.untitled"), doc: d ?? emptyDoc(), fields: fields ?? [] };
      if (!cur || cur.title !== next.title || !cur.doc.eq(next.doc) || JSON.stringify(cur.fields) !== JSON.stringify(next.fields)) changed.add(page);
      named.set(page, next);
    }
    base.set(page, d);
  }
  for (const page of [...journal.keys(), ...named.keys()]) {
    if (seen.has(page)) continue;
    journal.delete(page);
    named.delete(page);
    base.delete(page);
    changed.add(page);
  }
  return changed;
}

// Push local edits into Loro. Debounced, so typing makes one Loro change
// per pause rather than per key.
let flushTimer = null;
export function flush() {
  clearTimeout(flushTimer);
  for (const page of dirty) {
    const next = getPage(page);
    writePage(page, base.get(page) ?? null, next && !(isDate(page) && isEmpty(next)) ? next : null);
    base.set(page, next);
  }
  dirty.clear();
}
function markDirty(page) {
  dirty.add(page);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 400);
}

// Remote updates: local edits go in first so they are never overwritten by
// a rebuild, then every view that shows a changed page refreshes.
const remoteListeners = new Set();
export const onRemote = (fn) => { remoteListeners.add(fn); return () => remoteListeners.delete(fn); };

export function importRemote(bytes) {
  flush();
  doc.import(bytes);
  const changed = rebuild();
  if (changed.size) for (const fn of remoteListeners) fn(changed);
}

// ---------- persistence ----------

let snapTimer = null;
function scheduleSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => persistence.saveSnapshot(doc.export({ mode: "snapshot" })), 1000);
}

export const getMeta = () => meta;
export function saveMeta(patch) {
  meta = { ...meta, ...patch };
  persistence.saveMeta(meta);
}

export async function load() {
  await persistence.open();
  const saved = await persistence.load();
  meta = saved.meta;
  if (saved.snapshot) doc.import(saved.snapshot);
  doc.subscribe(() => scheduleSnapshot());
  rebuild();
  window.addEventListener("beforeunload", () => {
    flush();
    persistence.saveSnapshot(doc.export({ mode: "snapshot" }));
  });
}

// ---------- pages ----------

export const getPage = (id) => (isDate(id) ? journal.get(id) : named.get(id)?.doc) ?? null;
export const pageDates = () => new Set(journal.keys());

// A journal day exists only once something is written on it; named pages
// exist from the moment they are created.
export function savePage(id, d) {
  if (isDate(id)) {
    if (isEmpty(d)) journal.delete(id);
    else journal.set(id, d);
  } else {
    const page = named.get(id);
    if (!page) return;
    page.doc = d;
  }
  markDirty(id);
}

export function titleOf(id) {
  if (isDate(id)) return longDate(id);
  return named.get(id)?.title ?? t("page.deleted");
}

export function findPage(title) {
  const t = title.trim();
  if (isDate(t)) return t;
  if (isDate(t.replaceAll("/", "-"))) return t.replaceAll("/", "-"); // a journal title
  const key = t.toLowerCase();
  for (const [id, p] of named) if (p.title.toLowerCase() === key) return id;
  return null;
}

export function createPage(title) {
  const id = "p-" + newId();
  named.set(id, { title: title.trim(), doc: emptyDoc(), fields: [] });
  setTitle(id, title.trim());
  markDirty(id);
  relink("?" + title.trim(), id);
  return id;
}

// Point every link to `from` at `to` instead.
function relink(from, to) {
  for (const [page, d] of [...pagesAll()]) {
    let tr = null;
    d.descendants((n, pos) => {
      if (n.type === T.link && n.attrs.page === from) {
        tr ??= new Transform(d);
        tr.setNodeMarkup(pos, null, { ...n.attrs, page: to });
      }
    });
    if (tr) savePage(page, tr.doc);
  }
}

export const ensurePage = (title) => findPage(title) ?? createPage(title);

export function renamePage(id, title) {
  const page = named.get(id);
  if (!page || !title.trim()) return;
  page.title = title.trim();
  setTitle(id, page.title);
}

// Named pages only. Links and tags to it keep its name: they become links
// to a page that does not exist yet ("?title"), recreated when followed.
export function deletePage(id) {
  const page = named.get(id);
  if (!page) return;
  named.delete(id);
  relink(id, "?" + page.title);
  base.delete(id);
  dirty.delete(id);
  deleteInLoro(id);
}

// ---------- fields (tag pages define them, blocks hold values) ----------

export const getFields = (page) => named.get(page)?.fields ?? [];
export function savePageFields(page, fields) {
  const p = named.get(page);
  if (!p) return;
  p.fields = fields;
  setFields(page, fields);
}

// The fields a block offers: those of every page its line tags, in order.
export function fieldsForBlock(block) {
  const out = [];
  block.firstChild.forEach((n) => {
    if (n.type === T.link && n.attrs.tag) for (const f of getFields(n.attrs.page)) out.push(f);
  });
  return out;
}

export function fieldById(id) {
  for (const p of named.values()) for (const f of p.fields ?? []) if (f.id === id) return f;
  return null;
}

export function fieldByName(name) {
  for (const p of named.values()) for (const f of p.fields ?? []) if (f.name === name) return f;
  return null;
}

export function setBlockProp(id, fieldId, value) {
  updateBlockAttrs(id, (a) => {
    const props = { ...a.props };
    if (value === null || value === "") delete props[fieldId];
    else props[fieldId] = value;
    return { ...a, props };
  });
}

export const namedPages = () => [...named].map(([id, p]) => ({ id, title: p.title }));

// ---------- blocks ----------

export function* pagesAll() {
  for (const [id, d] of journal) yield [id, d];
  for (const [id, p] of named) yield [id, p.doc];
}

// Every block, with its page and the lines of its ancestors.
function* blocks() {
  for (const [page, d] of pagesAll()) {
    const out = [];
    const walk = (block, trail) => {
      const text = block.firstChild.textContent;
      out.push({ id: block.attrs.id, page, node: block, trail, text });
      block.forEach((child, _, i) => { if (i > 0) walk(child, [...trail, text]); });
    };
    d.forEach((b) => walk(b, []));
    yield* out;
  }
}

const linksIn = (line) => {
  const out = [];
  line.forEach((n) => { if (n.type === T.link) out.push(n.attrs.page); });
  return out;
};

function locate(id) {
  for (const [page, d] of pagesAll()) {
    let found = null;
    d.descendants((node, pos) => {
      if (found) return false;
      if (node.type === T.block && node.attrs.id === id) found = { page, doc: d, pos, node };
      return node.type === T.block;
    });
    if (found) return found;
  }
  return null;
}

export const getBlock = (id) => locate(id)?.node ?? null;
export const pageOfBlock = (id) => locate(id)?.page ?? null;

// Write back blocks edited elsewhere (agenda, task views, backlinks). `blocks`
// replaces the block `id`; when the editor showed it folded, its children are kept.
export function replaceBlock(id, blocks, { folded }) {
  const at = locate(id);
  if (!at) return;
  if (folded) {
    const [first, ...rest] = blocks;
    const kept = at.node.content.cut(at.node.firstChild.nodeSize);
    blocks = [first.copy(first.content.append(kept)), ...rest];
  }
  const tr = new Transform(at.doc).replaceWith(at.pos, at.pos + at.node.nodeSize, Fragment.fromArray(blocks));
  savePage(at.page, tr.doc);
}

export function updateBlockAttrs(id, fn) {
  const at = locate(id);
  if (!at) return;
  const tr = new Transform(at.doc).setNodeMarkup(at.pos, null, fn(at.node.attrs));
  savePage(at.page, tr.doc);
}

// Every block with a task state. `date` is set for journal pages only;
// `links` are the titles of the pages its line links to (for link: filters).
// The local day a done task was last marked done, from its log; null otherwise.
export function completedAt(attrs) {
  if (attrs.task !== "done") return null;
  const last = [...(attrs.log ?? [])].reverse().find((e) => e.state === "done");
  return last ? new Date(last.at).toLocaleDateString("sv") : null;
}

export function allTasks() {
  const out = [];
  for (const b of blocks()) {
    if (!b.node.attrs.task) continue;
    out.push({
      ...b,
      ...b.node.attrs,
      date: isDate(b.page) ? b.page : null,
      completed: completedAt(b.node.attrs),
      links: linksIn(b.node.firstChild).map(titleOf),
    });
  }
  return out;
}

// Blocks whose own line links to `page`.
export function backlinks(page) {
  return [...blocks()].filter((b) => linksIn(b.node.firstChild).includes(page));
}

export const getViews = () => (settings.get("views") ? JSON.parse(settings.get("views")) : null);
export function saveViews(v) {
  settings.set("views", JSON.stringify(v));
  doc.commit({ origin: "local" });
}
