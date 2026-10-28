#!/usr/bin/env node
// An MCP server (stdio) for the notebook: an agent such as Claude Code can
// list, read, search and write pages and journal days.
//
// It joins the sync relay as one more device, so its edits merge into the
// running app like edits from another computer. Configuration, first found:
//   SCRATCH_SYNC_URL, SCRATCH_SYNC_TOKEN, SCRATCH_NOTEBOOK (default "main")
//   the app's own sync settings, in <data dir>/scratch/meta.json
//     (SCRATCH_DATA_DIR overrides the directory)
// With no sync configured it reads <data dir>/scratch/notebook.loro, the
// app's local snapshot, and notebook.log, the updates saved since it
// (src/updatelog.js), and refuses to write: the running app would never
// see the change and would overwrite it.
//
//   npm run mcp
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { doc, invalidate } from "../src/loro.js";
import { readLog } from "../src/updatelog.js";
import { syncClient } from "./sync.js";
import * as nb from "./notebook.js";

const log = (msg) => process.stderr.write(msg + "\n");

// where Neutralino's os.getPath("data") puts the app's files
function dataDir() {
  if (process.env.SCRATCH_DATA_DIR) return process.env.SCRATCH_DATA_DIR;
  const home = os.homedir();
  const base = process.platform === "darwin" ? path.join(home, "Library", "Application Support")
    : process.platform === "win32" ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming"))
    : (process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"));
  return path.join(base, "scratch");
}

function syncConfig() {
  if (process.env.SCRATCH_SYNC_URL) {
    return { url: process.env.SCRATCH_SYNC_URL, token: process.env.SCRATCH_SYNC_TOKEN ?? "", notebook: process.env.SCRATCH_NOTEBOOK || "main" };
  }
  try {
    const sync = JSON.parse(fs.readFileSync(path.join(dataDir(), "meta.json"), "utf8")).sync;
    if (sync?.url) return { url: sync.url, token: sync.token ?? "", notebook: sync.notebook || "main" };
  } catch {}
  return null;
}

const cfg = syncConfig();
const sync = cfg && syncClient(doc, { ...cfg, log });
const snapshot = path.join(dataDir(), "notebook.loro");
if (sync) log(`scratch mcp: syncing notebook "${cfg.notebook}" with ${cfg.url}`);
else log(`scratch mcp: no sync configured, reading ${snapshot} (read-only)`);

async function before(write) {
  if (sync) {
    if (await sync.ready()) return;
    throw new Error(sync.state === "unauthorized" ? "the sync server rejected the token" : `cannot reach the sync server (${cfg.url})`);
  }
  if (write) throw new Error("read-only: the notebook is not synced. Set up sync in the app (or SCRATCH_SYNC_URL) so edits reach it");
  if (!fs.existsSync(snapshot)) throw new Error(`no notebook at ${snapshot}`);
  doc.import(new Uint8Array(fs.readFileSync(snapshot)));
  const updates = path.join(dataDir(), "notebook.log");
  if (fs.existsSync(updates)) for (const u of readLog(fs.readFileSync(updates))) { try { doc.import(u); } catch {} }
  invalidate();
}

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (e) => ({ content: [{ type: "text", text: e.message }], isError: true });

function tool(name, description, inputSchema, run, { write = false } = {}) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: !write } }, async (args) => {
    try {
      await before(write);
      const out = run(args);
      if (!write) return text(out);
      const sent = await sync.flushed();
      return text(JSON.stringify(out) + (sent ? "" : "\n(not yet acknowledged by the sync server; it is sent when the connection is back, if this server keeps running)"));
    } catch (e) {
      return fail(e);
    }
  });
}

const server = new McpServer({ name: "scratch", version: "1.0.0" }, {
  instructions: [
    "The user's notes: an outliner with named pages and a journal (one page per day, YYYY-MM-DD).",
    "Pages are read and written in outline text: one block per line, `- ` after two spaces per level of nesting,",
    "optional TODO/DOING/DONE first, ` DEADLINE: <YYYY-MM-DD>` last. Inline: $LaTeX$ formulas, [[page]] links,",
    "#tag or #[[tag with spaces]], ((block-id)) references, **bold**, *italic*, `code`, ~~strike~~, ==highlight==.",
    "A property line `name:: value` sits one level under its block. A code block is a ``` fence, its body indented one level deeper.",
    "Each block line read ends with its id, ` ^id`; tools that change a block take that id. Ids in text you write are optional.",
  ].join(" "),
});

const pageArg = z.string().describe('a page title, a journal date YYYY-MM-DD, or "today"');
const outlineArg = z.string().describe("outline text: lines of `- block`, nested by two spaces; plain lines are taken as one block each");
const idArg = z.string().describe("a block id (the ^id at the end of a line read)");

tool("list_pages", "List the named pages (title and id) and the journal days that have something written, newest first.",
  { journal_limit: z.number().int().positive().optional().describe("at most this many journal days (default 60)") },
  ({ journal_limit = 60 }) => {
    const { pages, journal } = nb.listPages();
    return [
      `Pages (${pages.length}):`, ...pages.map((p) => `- ${p.title}  (${p.id})`),
      "", `Journal days (${journal.length}${journal.length > journal_limit ? `, newest ${journal_limit} shown` : ""}):`,
      journal.slice(0, journal_limit).join(", "),
    ].join("\n");
  });

tool("read_page", "Read a page or journal day as outline text, each block line ending with its ` ^id`.",
  { page: pageArg },
  ({ page }) => {
    const p = nb.readPage(page);
    return `# ${p.title}  (${p.id})\n${p.text || "(empty)"}`;
  });

tool("search", "Search every page and journal day for blocks containing all the words of the query (case-insensitive; formulas match by their LaTeX, links by the page title). Also lists pages whose title matches.",
  {
    query: z.string().describe("words that must all appear in a block's line; may be empty when filtering by task"),
    task: z.enum(["todo", "doing", "done"]).optional().describe("only blocks with this task state"),
    limit: z.number().int().positive().optional().describe("at most this many blocks (default 30)"),
  },
  ({ query, task, limit }) => {
    const { pages, blocks } = nb.search(query, { task: task ?? null, limit: limit ?? 30 });
    const out = [];
    if (pages.length) out.push("Pages:", ...pages.map((p) => `- ${p.title}  (${p.id})`), "");
    out.push(`Blocks (${blocks.length}):`);
    for (const b of blocks) {
      const trail = b.trail.length ? `  [under: ${b.trail.map((s) => s.slice(0, 60)).join(" › ")}]` : "";
      out.push(`- ${b.title}: ${b.task ? b.task.toUpperCase() + " " : ""}${b.text}${b.deadline ? ` DEADLINE: <${b.deadline}>` : ""} ^${b.id}${trail}`);
    }
    return out.join("\n");
  });

tool("create_page", "Create a named page, optionally with content. Links already written to that title now point at it.",
  { title: z.string(), content: outlineArg.optional() },
  ({ title, content }) => nb.createPage(title, content ?? ""), { write: true });

tool("append_blocks", "Append blocks at the end of a page or journal day (today's journal with page \"today\"), or as the last children of a block.",
  { page: pageArg.optional().describe('the page; default "today"'), text: outlineArg, parent_id: idArg.optional().describe("append as children of this block instead") },
  ({ page, text, parent_id }) => nb.appendBlocks(page ?? "today", text, parent_id ?? null), { write: true });

tool("insert_blocks", "Insert blocks next to a block: before or after it, or as its first or last children.",
  { id: idArg, text: outlineArg, position: z.enum(["before", "after", "first_child", "last_child"]).optional().describe("default after") },
  ({ id, text, position }) => nb.insertBlocks(id, text, position ?? "after"), { write: true });

tool("replace_block", "Replace a block and its children with the blocks of `text` (empty text deletes it). The first new block keeps the old id; ^ids from the old subtree written in `text` are kept too, so ((references)) to them still work. To keep the children, read them and include them.",
  { id: idArg, text: z.string() },
  ({ id, text }) => nb.replaceBlock(id, text), { write: true });

tool("set_task", "Set a block's task state (none removes it). The change is logged with its time, as in the app.",
  { id: idArg, state: z.enum(["todo", "doing", "done", "none"]) },
  ({ id, state }) => nb.setTask(id, state), { write: true });

tool("set_deadline", "Set or clear a block's deadline.",
  { id: idArg, date: z.string().nullable().describe("YYYY-MM-DD, or null to clear") },
  ({ id, date }) => nb.setDeadline(id, date), { write: true });

await server.connect(new StdioServerTransport());
