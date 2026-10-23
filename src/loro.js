import { LoroDoc } from "loro-crdt/base64";
import { schema } from "./schema.js";

// The notebook as one Loro document: the CRDT that is persisted and synced.
//
//   tree "blocks"   roots are pages     data { page, title? }
//                   below them, blocks  data { bid, line, task, deadline, log, folded, props }
//   page roots also carry `fields`: the field definitions of a tag page (JSON)
//   map "settings"  views (saved task views, JSON)
//
// Structure (parent, order) lives in the tree, so concurrent moves merge.
// Each block field is a separate map entry; `line` (the block's inline
// content as JSON) is last-writer-wins per block.
//
// ProseMirror docs are kept as the working copy. writePage() pushes only what
// changed since `base` (the version last read or written), so it never
// reverts blocks another device changed in the meantime.

const T = schema.nodes;
export const doc = new LoroDoc();
const tree = doc.getTree("blocks");
tree.enableFractionalIndex(0);
export const settings = doc.getMap("settings");

const FIELDS = ["line", "task", "deadline", "log", "folded", "props"];

// ---------- reading ----------

// Several roots can carry the same page (two devices created the same day
// offline); they are read as one page, children in root-id order.
function rootsByPage() {
  const out = new Map();
  for (const r of tree.roots()) {
    const page = r.data.get("page");
    if (!page) continue;
    if (!out.has(page)) out.set(page, []);
    out.get(page).push(r);
  }
  for (const list of out.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

function readBlock(node) {
  const d = node.data;
  const line = d.get("line") ? schema.nodeFromJSON(JSON.parse(d.get("line"))) : T.line.create();
  const children = (node.children() ?? []).map(readBlock);
  return T.block.create(
    { id: d.get("bid"), task: d.get("task") ?? null, deadline: d.get("deadline") ?? null, log: JSON.parse(d.get("log") ?? "[]"), folded: !!d.get("folded"), props: JSON.parse(d.get("props") ?? "{}") },
    [line, ...children],
  );
}

// { pageId: { title, doc } } for every page in the notebook
export function readAll() {
  const out = new Map();
  for (const [page, roots] of rootsByPage()) {
    const blocks = roots.flatMap((r) => (r.children() ?? []).map(readBlock));
    const title = roots.map((r) => r.data.get("title")).find(Boolean) ?? null;
    const fields = JSON.parse(roots.map((r) => r.data.get("fields")).find(Boolean) ?? "[]");
    out.set(page, { title, fields, doc: blocks.length ? T.doc.create(null, blocks) : null });
  }
  return out;
}

// ---------- writing ----------

let index = null; // bid -> tree node
function nodeOf(bid) {
  if (!index) {
    index = new Map();
    for (const n of tree.nodes()) if (!n.isDeleted() && n.data.get("bid")) index.set(n.data.get("bid"), n);
  }
  return index.get(bid);
}
export const invalidate = () => { index = null; };

function rootOf(page) {
  const existing = rootsByPage().get(page)?.[0];
  if (existing) return existing;
  const r = tree.createNode();
  r.data.set("page", page);
  return r;
}

// bid -> { parent, prev, fields } in document order
function flatten(pmDoc) {
  const out = new Map();
  if (!pmDoc) return out;
  const walk = (parent, siblings) => {
    let prev = null;
    for (const b of siblings) {
      const a = b.attrs;
      out.set(a.id, {
        parent, prev,
        fields: { line: JSON.stringify(b.firstChild.toJSON()), task: a.task, deadline: a.deadline, log: JSON.stringify(a.log), folded: a.folded || null, props: Object.keys(a.props).length ? JSON.stringify(a.props) : null },
      });
      prev = a.id;
      const kids = [];
      b.forEach((c, _, i) => { if (i > 0) kids.push(c); });
      walk(a.id, kids);
    }
  };
  const top = [];
  pmDoc.forEach((b) => top.push(b));
  walk(null, top);
  return out;
}

export function writePage(page, base, next) {
  const before = flatten(base), after = flatten(next);
  const root = rootOf(page);
  const parentNode = (bid) => (bid ? nodeOf(bid) : root);
  const place = (n, info) => {
    const prev = info.prev && nodeOf(info.prev);
    if (prev) n.moveAfter(prev);
    else n.move(parentNode(info.parent) ?? root, 0);
  };

  for (const [bid, info] of after) {
    let n = nodeOf(bid);
    const old = before.get(bid);
    if (!n) {
      n = (parentNode(info.parent) ?? root).createNode();
      n.data.set("bid", bid);
      index.set(bid, n);
      place(n, info);
    } else if (!old || old.parent !== info.parent || old.prev !== info.prev) {
      place(n, info);
    }
    for (const f of FIELDS) {
      const v = info.fields[f];
      if (!old || old.fields[f] !== v) {
        if (v === null || v === undefined) n.data.delete(f);
        else n.data.set(f, v);
      }
    }
  }
  for (const bid of before.keys()) {
    if (after.has(bid)) continue;
    const n = nodeOf(bid);
    if (n && !n.isDeleted()) { tree.delete(n.id); index.delete(bid); }
  }
  doc.commit({ origin: "local" });
}

// The page's roots go, and their blocks with them.
export function deletePage(page) {
  for (const r of rootsByPage().get(page) ?? []) tree.delete(r.id);
  invalidate();
  doc.commit({ origin: "local" });
}

export function setFields(page, fields) {
  rootOf(page).data.set("fields", JSON.stringify(fields));
  doc.commit({ origin: "local" });
}

export function setTitle(page, title) {
  rootOf(page).data.set("title", title);
  doc.commit({ origin: "local" });
}
