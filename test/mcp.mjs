// The MCP server (mcp/server.mjs) end to end: a local sync server
// (sync/server.mjs), the MCP server as a subprocess driven over stdio by an
// MCP client, and "the app": a Loro document read and written with the app's
// own src/loro.js and src/outline-io.js, on the sync relay as another device.
// Every edit made through a tool must show up in the app's document, and
// edits made in the app in the meantime must survive.
//   node test/mcp.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { doc, readAll, writePage, setTitle, invalidate } from "../src/loro.js";
import { parseOutline, serializeOutline, resolver } from "../src/outline-io.js";
import { Transform } from "prosemirror-transform";
import { LoroDoc } from "loro-crdt";
import { schema } from "../src/schema.js";

const root = new URL("..", import.meta.url).pathname;
const PORT = 19000 + Math.floor(Math.random() * 1000), TOKEN = "test-token";
const SYNC_URL = `ws://localhost:${PORT}/sync`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-mcp-"));
const relay = spawn(process.execPath, [path.join(root, "sync/server.mjs")], {
  env: { ...process.env, SYNC_TOKEN: TOKEN, PORT: String(PORT), DATA_DIR: path.join(tmp, "relay") },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => relay.stdout.once("data", resolve));

const fails = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) { fails.push(what); if (detail) console.log(detail); } };
const same = (got, want, what) => check(got === want, what, `--- got\n${got}\n--- want\n${want}`);
const until = async (cond, ms = 4000) => { for (let k = 0; k < ms / 20 && !(await cond()); k++) await new Promise((r) => setTimeout(r, 20)); return cond(); };
const today = new Date().toLocaleDateString("sv");

// ---------- the app: its own Loro document on the relay ----------

const isDate = (id) => /^\d{4}-\d\d-\d\d$/.test(id);
let app = new Map();
const appRead = () => { invalidate(); app = readAll(); return app; };
const appTitle = (id) => (isDate(id) ? id : id.startsWith("?") ? id.slice(1) : app.get(id)?.title ?? id);
const appFind = (title) => [...app].find(([id, p]) => !isDate(id) && p.title === title)?.[0];
resolver.title = appTitle;
resolver.pageId = (title) => (isDate(title) ? title : appFind(title) ?? "?" + title);

// the app's view of a page, in its export form (no ids)
const appText = (title) => {
  appRead();
  const id = isDate(title) ? title : appFind(title);
  const d = app.get(id)?.doc;
  return d ? serializeOutline(d) : null;
};
const appBlocks = () => {
  appRead();
  const out = new Map();
  for (const [page, { doc: d }] of app) d?.descendants((n) => { if (n.attrs.id && n.type.name === "block") out.set(n.attrs.id, { page, attrs: n.attrs, text: n.firstChild.textContent }); return true; });
  return out;
};
const linksFrom = (title) => {
  appRead();
  const out = [];
  app.get(appFind(title))?.doc?.descendants((n) => { if (n.type.name === "link") out.push(n.attrs.page); return true; });
  return out;
};
const idOf = (text) => [...appBlocks()].find(([, b]) => b.text === text)?.[0];

const appWrite = (title, text) => {
  appRead();
  let id = isDate(title) ? title : appFind(title);
  if (!id) { id = "p-" + Math.random().toString(36).slice(2, 10); setTitle(id, title); }
  writePage(id, app.get(id)?.doc ?? null, parseOutline(text));
};

const ws = new WebSocket(`${SYNC_URL}?token=${TOKEN}&notebook=main`);
ws.binaryType = "arraybuffer";
let appSynced, frameId = 1, online = true;
const held = [];
const appReady = new Promise((r) => { appSynced = r; });
ws.onmessage = (ev) => {
  if (typeof ev.data === "string") { if (JSON.parse(ev.data).type === "synced") appSynced(); return; }
  doc.import(new Uint8Array(ev.data, 9));
};
const pushFrame = (u) => {
  const frame = new Uint8Array(4 + u.length);
  new DataView(frame.buffer).setUint32(0, frameId++);
  frame.set(u, 4);
  ws.send(frame);
};
// "offline": local edits are held back, and sent when back online
doc.subscribeLocalUpdates((u) => (online ? pushFrame(u) : held.push(u)));
const goOnline = () => { online = true; for (const u of held.splice(0)) pushFrame(u); };
await new Promise((r) => { ws.onopen = r; });
ws.send(JSON.stringify({ type: "hello", since: 0 }));
await appReady;

const TOPOLOGY = [
  "- a space is $\\left(X,\\tau\\right)$ with **open** sets",
  "  - see [[Mac Lane]] and #category",
  "    difficulty:: medium",
  "  - TODO prove $\\overline{A\\cup B}=\\overline{A}\\cup\\overline{B}$ DEADLINE: <2026-11-01>",
  "- ```js",
  "  let open = (U) => true",
  "  ```",
  "- compact means every open cover has a finite subcover",
].join("\n");
appWrite("Topology", TOPOLOGY);
appWrite(today, "- morning: read about compactness");

// ---------- the MCP server ----------

async function mcp(env) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    // MCP_SERVER=dist/mcp/scratch-mcp.mjs tests the bundled one
    args: [path.resolve(root, process.env.MCP_SERVER ?? "mcp/server.mjs")],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SCRATCH_DATA_DIR: path.join(tmp, "nodata"), ...env },
    stderr: "pipe",
  }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c) => c.text).join(""), error: !!r.isError };
  };
  return { client, call };
}
const { client, call } = await mcp({ SCRATCH_SYNC_URL: SYNC_URL, SCRATCH_SYNC_TOKEN: TOKEN });
const strip = (s) => s.replace(/ \^[a-z0-9]+$/gm, "");
const body = (r) => r.text.split("\n").slice(1).join("\n"); // without the "# title" line
const ids = (r) => JSON.parse(r.text.split("\n")[0]).ids;

const tools = (await client.listTools()).tools.map((t) => t.name).sort().join(",");
same(tools, "append_blocks,create_page,insert_blocks,list_pages,read_page,replace_block,search,set_deadline,set_task", "the tools on offer");

// ---------- reading ----------

const list = await call("list_pages");
check(list.text.includes("- Topology  (p-") && list.text.includes(today), "list_pages: the app's page and today's journal");

const topo = await call("read_page", { page: "topology" });
same(strip(body(topo)), TOPOLOGY, "read_page: every construct of the text form reads back as the app writes it");
check(body(topo).split("\n").filter((l) => /^ *- /.test(l)).every((l) => / \^[a-z0-9]+$/.test(l)), "read_page: each block line ends with its id");
check(!/^ *let open.*\^/m.test(body(topo)) && !/difficulty.*\^/.test(body(topo)), "read_page: code lines and property lines carry no id");
same(strip(body(await call("read_page", { page: "today" }))), "- morning: read about compactness", 'read_page: "today" is today\'s journal');
same(body(await call("read_page", { page: "2001-01-01" })), "(empty)", "read_page: a journal day with nothing on it is empty");
check((await call("read_page", { page: "No Such Page" })).error, "read_page: an unknown title is an error");

for (const [query, want, what] of [
  ["COMPACT", ["morning: read about compactness", "compact means every open cover has a finite subcover"], "any case, journal first"],
  ["finite open", ["compact means every open cover has a finite subcover"], "all words, in any order"],
  ["\\overline{A", ["TODO prove"], "inside a formula, by its LaTeX"],
  ["[[mac lane]]", ["see [[Mac Lane]]"], "a link, by its title"],
  ["#category", ["#category"], "a tag"],
  ["let open", ["let open = (U) => true"], "inside a code block"],
  ["zebra", [], "nothing"],
]) {
  const r = await call("search", { query });
  const lines = r.text.split("\n").filter((l) => l.startsWith("- "));
  check(lines.length === want.length && want.every((w, i) => lines[i].includes(w)), `search: ${what}`, r.text);
}
const tasks = await call("search", { query: "", task: "todo" });
check(tasks.text.includes("TODO prove") && tasks.text.includes("DEADLINE: <2026-11-01>") && tasks.text.includes("[under: a space is"), "search: by task state, with deadline and the blocks above it", tasks.text);
check((await call("search", { query: "topo" })).text.includes("Pages:\n- Topology"), "search: page titles");

// ---------- writing: every edit reaches the app ----------

let r = await call("append_blocks", { page: "today", text: "- TODO call Alice\n  - about $x_i^2$" });
check(!r.error && (await until(() => appText(today)?.endsWith("- TODO call Alice\n  - about $x_i^2$"))), "append_blocks: to today's journal, nested, reaches the app", appText(today));
r = await call("append_blocks", { page: "2026-01-02", text: "first line\nsecond line" });
await until(() => appText("2026-01-02"));
same(appText("2026-01-02"), "- first line\n- second line", "append_blocks: plain lines to a new journal day, one block each");
check((await call("append_blocks", { page: "Nowhere", text: "- x" })).error, "append_blocks: to a page that does not exist is an error");

r = await call("create_page", { title: "Mac Lane", content: "- Categories for the Working Mathematician" });
const macId = JSON.parse(r.text).id;
await until(() => appText("Mac Lane") !== null);
same(appText("Mac Lane"), "- Categories for the Working Mathematician", "create_page: with content, reaches the app");
check((await until(() => linksFrom("Topology").includes(macId))) && !linksFrom("Topology").includes("?Mac Lane"), "create_page: the app's [[Mac Lane]] link now points at the new page", linksFrom("Topology").join(", "));
check((await call("create_page", { title: "mac lane" })).error, "create_page: a title that exists (any case) is an error");
check((await call("create_page", { title: today })).error, "create_page: a date is a journal day, not a page");
r = await call("create_page", { title: "Empty" });
check(await until(() => appText("Empty") === "- "), "create_page: without content, one empty block as in the app");

const anchor = idOf("compact means every open cover has a finite subcover");
for (const [position, want] of [
  ["before", "- B\n- compact means every open cover has a finite subcover"],
  ["after", "- compact means every open cover has a finite subcover\n- A"],
  ["first_child", "- compact means every open cover has a finite subcover\n  - F"],
  ["last_child", "  - F\n  - L"],
]) {
  r = await call("insert_blocks", { id: anchor, position, text: { before: "B", after: "A", first_child: "F", last_child: "L" }[position] });
  check(!r.error && (await until(() => appText("Topology").includes(want))), `insert_blocks: ${position}`, appText("Topology"));
}
r = await call("append_blocks", { page: "Topology", parent_id: anchor, text: "- P" });
check(await until(() => appText("Topology").includes("  - L\n  - P")), "append_blocks: as the last children of a block");

// text read with ^ids and written back elsewhere is a copy: new ids
const copied = body(await call("read_page", { page: "Topology" })).split("\n").slice(0, 4).join("\n");
r = await call("append_blocks", { page: "2026-01-03", text: copied });
await until(() => appText("2026-01-03"));
same(appText("2026-01-03"), TOPOLOGY.split("\n").slice(0, 4).join("\n"), "append_blocks: text as read_page gives it (with ^ids) writes back the same");
const seen = [...appBlocks().keys()];
check(seen.length === new Set(seen).size && ids(r).every((id) => !copied.includes(id)), "append_blocks: a copy gets new ids, no id is in the notebook twice");

// a code block's body is text: a "- … ^id" line in it is kept as written
const CODE = "- ```md\n  - item ^abcd1234\n  ```\n- after";
await call("append_blocks", { page: "2026-01-04", text: CODE });
check(await until(() => appText("2026-01-04") === CODE), "append_blocks: lines inside a code block are code, ids and all", appText("2026-01-04"));

// the block is replaced, its id stays, and a child written back with its ^id keeps it
const child = idOf("F");
r = await call("replace_block", { id: anchor, text: `- every open cover has a finite subcover\n  - F' ^${child}\n  - new` });
await until(() => appBlocks().get(anchor)?.text === "every open cover has a finite subcover");
check(appBlocks().get(anchor)?.text === "every open cover has a finite subcover", "replace_block: the first block keeps the old id");
check(appBlocks().get(child)?.text === "F'", "replace_block: a child written with its ^id keeps it");
check(!idOf("L") && !idOf("P") && !!idOf("new"), "replace_block: children not written back are gone, new ones are there");
r = await call("replace_block", { id: idOf("B"), text: "" });
check(await until(() => !idOf("B")), "replace_block: empty text deletes the block");
const onlyEmpty = idOf("Categories for the Working Mathematician");
await call("replace_block", { id: onlyEmpty, text: "" });
check(await until(() => appText("Mac Lane") === "- "), "replace_block: deleting a page's only block leaves one empty block");
check((await call("replace_block", { id: "nosuchid", text: "- x" })).error, "replace_block: an unknown id is an error");

const alice = idOf("call Alice");
for (const state of ["doing", "done", "none", "todo"]) {
  await call("set_task", { id: alice, state });
  const want = state === "none" ? null : state;
  check(await until(() => appBlocks().get(alice)?.attrs.task === want && appBlocks().get(alice).attrs.log.at(-1)?.state === state), `set_task: ${state}, logged as in the app`);
}
await call("set_deadline", { id: alice, date: "2026-12-24" });
check(await until(() => appText(today).includes("- TODO call Alice DEADLINE: <2026-12-24>")), "set_deadline: set");
await call("set_deadline", { id: alice, date: null });
check(await until(() => appBlocks().get(alice)?.attrs.deadline === null), "set_deadline: cleared");
check((await call("set_deadline", { id: alice, date: "tomorrow" })).error, "set_deadline: not a date is an error");

// ---------- edits on both sides merge ----------

// the app goes offline and edits one block while the MCP server edits another
online = false;
appRead();
const topoId = appFind("Topology");
const appDoc = app.get(topoId).doc;
const lineEnd = 1 + appDoc.firstChild.firstChild.nodeSize - 1;
writePage(topoId, appDoc, new Transform(appDoc).insert(lineEnd, schema.text(" (edited in the app)")).doc);
await call("append_blocks", { page: "Topology", text: "- written through MCP while the app was offline" });
goOnline();
check(await until(() => appText("Topology").includes("(edited in the app)") && appText("Topology").includes("written through MCP while the app was offline")), "an offline app edit and an MCP edit both survive in the app");
check(await until(async () => strip(body(await call("read_page", { page: "Topology" }))).includes("sets (edited in the app)")), "the app's edit reaches the MCP server");

// ---------- tags an older version kept in the line ----------

{
  appWrite("Old tags", "- heff");
  const bid = idOf("heff");
  // the line as an older version wrote it: the tag a link inside it
  const node = [...doc.getTree("blocks").nodes()].find((n) => n.data.get("bid") === bid);
  node.data.set("line", JSON.stringify({ type: "line", content: [{ type: "text", text: "heff " }, { type: "link", attrs: { page: "?Project", tag: true } }] }));
  doc.commit();
  same(appText("Old tags"), "- heff #Project", "an older line's inline tag is read as the block's");
  // only the tags change: the line is written too, or the old one brings the tag back
  appRead();
  const id = appFind("Old tags"), d = app.get(id).doc;
  writePage(id, d, new Transform(d).setNodeMarkup(0, null, { ...d.firstChild.attrs, tags: [] }).doc);
  same(appText("Old tags"), "- heff", "a tag taken off an older line stays off");
}

// ---------- without sync: read the app's files, write to its inbox ----------

const local = path.join(tmp, "local"), inbox = path.join(local, "inbox");
fs.mkdirSync(local);
fs.writeFileSync(path.join(local, "notebook.loro"), doc.export({ mode: "snapshot" }));
const inboxFiles = () => (fs.existsSync(inbox) ? fs.readdirSync(inbox).sort() : []);
const off = await mcp({ SCRATCH_DATA_DIR: local });
check(strip(body(await off.call("read_page", { page: "Topology" }))).includes("(edited in the app)"), "no sync: reads the app's snapshot");
const wrote = await off.call("append_blocks", { page: "today", text: "- offline one" });
check(!wrote.error, "no sync: a write is accepted", wrote.text);
await off.call("append_blocks", { page: "today", text: "- offline two" });
check(inboxFiles().length === 2 && inboxFiles().every((n) => n.endsWith(".loro")), "no sync: each write is one file in the inbox", inboxFiles().join("\n"));
await off.client.close();

// what the app does with them (src/inbox.js): merge, save, remove
const merged = new LoroDoc();
merged.import(new Uint8Array(fs.readFileSync(path.join(local, "notebook.loro"))));
for (const n of inboxFiles()) check(!merged.import(new Uint8Array(fs.readFileSync(path.join(inbox, n)))).pending, "no sync: an inbox file applies on the app's snapshot");
const mergedText = JSON.stringify(merged.toJSON());
check(mergedText.includes("offline one") && mergedText.includes("offline two"), "no sync: the inbox holds both writes");

const again = await mcp({ SCRATCH_DATA_DIR: local });
const pending = strip(body(await again.call("read_page", { page: "today" })));
check(pending.includes("offline one") && pending.includes("offline two"), "no sync: a new server reads what still waits in the inbox", pending);
await again.client.close();

fs.writeFileSync(path.join(local, "notebook.loro"), merged.export({ mode: "snapshot" }));
for (const n of inboxFiles()) fs.rmSync(path.join(inbox, n));
const after = await mcp({ SCRATCH_DATA_DIR: local });
const taken = strip(body(await after.call("read_page", { page: "today" })));
check(taken.split("offline one").length === 2 && taken.split("offline two").length === 2, "no sync: once the app took them, each is there once", taken);
await after.client.close();

const fresh = path.join(tmp, "fresh");
const empty = await mcp({ SCRATCH_DATA_DIR: fresh });
check((await empty.call("read_page", { page: "today" })).error, "no sync: no notebook yet, reading is an error");
const first = await empty.call("create_page", { title: "First", content: "- hello" });
check(!first.error && fs.readdirSync(path.join(fresh, "inbox")).length === 1, "no sync: no notebook yet, a write starts the inbox", first.text);
await empty.client.close();

fs.writeFileSync(path.join(local, "meta.json"), JSON.stringify({ sync: { url: SYNC_URL, token: "wrong", notebook: "main" } }));
const bad = await mcp({ SCRATCH_DATA_DIR: local });
const denied = await bad.call("list_pages");
check(denied.error && denied.text.includes("rejected the token"), "the app's sync settings are used; a wrong token is an error");
await bad.client.close();

await client.close();
ws.close();
relay.kill();
fs.rmSync(tmp, { recursive: true, force: true });
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nall passed");
process.exit(0);
