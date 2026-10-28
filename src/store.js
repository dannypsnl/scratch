import { Fragment } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { schema } from "./schema.js";
import { emptyDoc, newId } from "./outline-io.js";
import { doc, settings, readAll, takeTouched, writePage, setTitle, setFields, invalidate, deletePage as deleteInLoro } from "./loro.js";
import { persistence } from "./persist.js";
import { t } from "./i18n.js";
import { longDate } from "./dates.js";

// Pages are outlines. A page id is either a date ("YYYY-MM-DD", a journal
// day) or "p-…" for a named page. The Loro document (loro.js) is the source of
// truth that is persisted and synced; ProseMirror docs here are the working
// copy every view reads. Queries go through each doc's block index
// (indexOf), built once per doc: docs are immutable, so an index never goes
// stale, and a page that did not change keeps its doc and its index.

const T = schema.nodes;
const journal = new Map(); // date -> doc
const named = new Map(); // id -> { title, doc, fields }
const base = new Map(); // page -> doc as last read from / written to Loro
const dirty = new Set(); // pages edited since the last flush
let meta = {};
let fieldsRevision = 0; // bumped whenever a page's field definitions change

export const isDate = (id) => /^\d{4}-\d\d-\d\d$/.test(id);

const isEmpty = (d) =>
  d.childCount === 1 && d.firstChild.childCount === 1 &&
  d.firstChild.firstChild.content.size === 0 && !d.firstChild.attrs.task && !d.firstChild.attrs.deadline;

// ---------- Loro <-> working copy ----------

// Read pages back from Loro: `pages` (a Set), or all of them when null.
// A page whose content is unchanged keeps its doc (and so its index, and
// the identity views compare).
function rebuild(pages = null) {
  if (!pages) invalidate();
  const changed = new Set();
  const seen = new Set();
  for (const [page, { title, fields, doc: read }] of readAll(pages)) {
    seen.add(page);
    let d = read;
    if (isDate(page)) {
      if (!d) { if (journal.delete(page)) changed.add(page); base.set(page, null); continue; }
      const cur = journal.get(page);
      if (cur?.eq(d)) d = cur;
      else changed.add(page);
      journal.set(page, d);
    } else {
      const cur = named.get(page);
      const next = { title: title ?? cur?.title ?? t("page.untitled"), doc: d ?? emptyDoc(), fields: fields ?? [] };
      if (cur?.doc.eq(next.doc)) next.doc = cur.doc;
      const sameFields = !!cur && JSON.stringify(cur.fields) === JSON.stringify(next.fields);
      if (!sameFields) fieldsRevision++;
      if (!cur || cur.title !== next.title || cur.doc !== next.doc || !sameFields) changed.add(page);
      named.set(page, next);
      if (d) d = next.doc;
    }
    base.set(page, d);
  }
  for (const page of pages ?? [...journal.keys(), ...named.keys()]) {
    if (seen.has(page) || !(journal.has(page) || named.has(page))) continue;
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

// False when the update waits on changes this device does not have.
export function importRemote(bytes) {
  flush();
  takeTouched();
  const { pending } = doc.import(bytes);
  const touched = takeTouched();
  const changed = touched?.size === 0 ? touched : rebuild(touched);
  if (changed.size) for (const fn of remoteListeners) fn(changed);
  return !pending;
}

// ---------- persistence ----------

// Saved as a snapshot and a log of the updates since: a save appends only
// what changed since the last one (a few hundred bytes for a pause in
// typing), and the log is folded into a new snapshot once it outgrows it
// (and after loading a log), so a whole snapshot is written now and then
// rather than at every pause.
let saveTimer = null;
let saving = Promise.resolve();
let saved = null; // the oplog version the store holds
let logBytes = 0, logCount = 0, snapshotBytes = 0;
const LOG_MAX_COUNT = 500;
const logMaxBytes = () => Math.max(256 * 1024, snapshotBytes);
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1000);
}
// one write at a time and in order, so the log never runs ahead of its snapshot
function queue(write) {
  saving = saving.then(write).catch((e) => console.error("saving the notebook failed", e));
  return saving;
}
function compact() {
  clearTimeout(saveTimer);
  const bytes = doc.export({ mode: "snapshot" });
  saved = doc.oplogVersion();
  snapshotBytes = bytes.length;
  logBytes = logCount = 0;
  return queue(() => persistence.saveSnapshot(bytes));
}
function save() {
  clearTimeout(saveTimer);
  const now = doc.oplogVersion();
  if (!saved) return compact();
  if (now.compare(saved) === 0) return saving;
  const bytes = doc.export({ mode: "update", from: saved });
  saved = now;
  logBytes += bytes.length;
  logCount++;
  if (logBytes > logMaxBytes() || logCount > LOG_MAX_COUNT) return compact();
  return queue(() => persistence.appendUpdate(bytes));
}

export const getMeta = () => meta;
export function saveMeta(patch) {
  meta = { ...meta, ...patch };
  persistence.saveMeta(meta);
}

export async function load() {
  await persistence.open();
  const stored = await persistence.load();
  meta = stored.meta;
  if (stored.snapshot) doc.import(stored.snapshot);
  importLog(stored.updates);
  takeTouched();
  saved = doc.oplogVersion();
  snapshotBytes = stored.snapshot?.length ?? 0;
  doc.subscribe(() => scheduleSave());
  rebuild();
  // a log from the last session is folded in once the window is up
  if (stored.updates.length) setTimeout(compact, 3000);
  window.addEventListener("beforeunload", () => {
    flush();
    save();
  });
}

// (an update that does not import, cut short by a crash, is left out)
function importLog(updates) {
  if (!updates.length) return;
  try { doc.importBatch(updates); }
  catch {
    for (const u of updates) { try { doc.import(u); } catch (e) { console.error("a saved update did not load", e); } }
  }
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

// Point every link and tag to `from` at `to` instead.
function relink(from, to) {
  for (const [page, d] of [...pagesAll()]) {
    let tr = null;
    d.descendants((n, pos) => {
      if (n.type === T.link && n.attrs.page === from) {
        tr ??= new Transform(d);
        tr.setNodeMarkup(pos, null, { ...n.attrs, page: to });
      }
      if (n.type === T.block && n.attrs.tags.includes(from)) {
        tr ??= new Transform(d);
        tr.setNodeMarkup(pos, null, { ...n.attrs, tags: n.attrs.tags.map((p) => (p === from ? to : p)) });
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
  if (page.fields.length) fieldsRevision++;
  relink(id, "?" + page.title);
  base.delete(id);
  dirty.delete(id);
  deleteInLoro(id);
}

// ---------- fields (tag pages define them, blocks hold values) ----------

export const getFields = (page) => named.get(page)?.fields ?? [];
// (editors draw a block's fields: they draw again when this changes)
export const fieldsVersion = () => fieldsRevision;
export function savePageFields(page, fields) {
  const p = named.get(page);
  if (!p) return;
  p.fields = fields;
  fieldsRevision++;
  setFields(page, fields);
}

// The fields a block offers: those of every page it is tagged with, in order.
export const fieldsForBlock = (block) => block.attrs.tags.flatMap(getFields);

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

// The pages a block's line links to, then those it is tagged with.
export const linksIn = (block) => {
  const out = [];
  block.firstChild.forEach((n) => { if (n.type === T.link) out.push(n.attrs.page); });
  return [...out, ...block.attrs.tags];
};

// A page doc's blocks in document order, each { id, node, pos, trail, text,
// targets } (trail: the lines of its ancestors; targets: linksIn), and the
// first block with each id. Made once per doc.
const indexes = new WeakMap();
function indexOf(d) {
  let ix = indexes.get(d);
  if (ix) return ix;
  ix = { blocks: [], byId: new Map() };
  const walk = (block, pos, trail) => {
    const text = block.firstChild.textContent;
    const entry = { id: block.attrs.id, node: block, pos, trail, text, targets: linksIn(block) };
    ix.blocks.push(entry);
    if (!ix.byId.has(entry.id)) ix.byId.set(entry.id, entry);
    block.forEach((child, offset, i) => { if (i > 0) walk(child, pos + 1 + offset, [...trail, text]); });
  };
  d.forEach((b, offset) => walk(b, offset, []));
  indexes.set(d, ix);
  return ix;
}

// Every block, with its page.
function* blocks() {
  for (const [page, d] of pagesAll()) for (const b of indexOf(d).blocks) yield { ...b, page };
}

function locate(id) {
  for (const [page, d] of pagesAll()) {
    const b = indexOf(d).byId.get(id);
    if (b) return { page, doc: d, pos: b.pos, node: b.node };
  }
  return null;
}

export const getBlock = (id) => locate(id)?.node ?? null;
export const pageOfBlock = (id) => locate(id)?.page ?? null;

// Write back blocks edited elsewhere (agenda, task views, backlinks). `blocks`
// replaces the block `id`.
export function replaceBlock(id, blocks) {
  const at = locate(id);
  if (!at) return;
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
  for (const [page, d] of pagesAll()) {
    for (const b of indexOf(d).blocks) {
      if (!b.node.attrs.task) continue;
      out.push({
        ...b,
        page,
        ...b.node.attrs,
        date: isDate(page) ? page : null,
        completed: completedAt(b.node.attrs),
        links: b.targets.map(titleOf),
      });
    }
  }
  return out;
}

// Blocks whose own line links to `page`, or that are tagged with it.
export function backlinks(page) {
  return [...blocks()].filter((b) => b.targets.includes(page));
}

// For every page, how many blocks on other pages link to it or tag it.
export function backlinkCounts() {
  const counts = new Map();
  for (const [page, d] of pagesAll()) {
    for (const b of indexOf(d).blocks) {
      for (const target of new Set(b.targets)) if (target !== page) counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return counts;
}

export const getViews = () => (settings.get("views") ? JSON.parse(settings.get("views")) : null);
export function saveViews(v) {
  settings.set("views", JSON.stringify(v));
  doc.commit({ origin: "local" });
}
