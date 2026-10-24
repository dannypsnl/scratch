// The sync server on a machine of your own: the same relay as the Cloudflare
// Worker (src/index.js), same wire format, so the app needs only its URL.
// Updates go to one SQLite file, images to files named by their hash; the
// protocol is in src/core.js.
//
//   SYNC_TOKEN=… PORT=8787 DATA_DIR=./data node server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import * as Loro from "loro-crdt/nodejs";
import { notebook } from "./src/core.js";

const TOKEN = process.env.SYNC_TOKEN;
const PORT = Number(process.env.PORT ?? 8787);
const DATA = path.resolve(process.env.DATA_DIR ?? "data");
const MAX_BLOB = 32 * 1024 * 1024;
if (!TOKEN) {
  console.error("set SYNC_TOKEN (a long random string of your own)");
  process.exit(1);
}

fs.mkdirSync(path.join(DATA, "blobs"), { recursive: true });
const db = new DatabaseSync(path.join(DATA, "updates.sqlite"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS updates (notebook TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (notebook, seq))");
db.exec("CREATE TABLE IF NOT EXISTS snapshots (notebook TEXT PRIMARY KEY, seq INTEGER NOT NULL, data BLOB NOT NULL)");
const lastSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM updates WHERE notebook = ?");
const insert = db.prepare("INSERT INTO updates (notebook, seq, data) VALUES (?, ?, ?)");
const since = db.prepare("SELECT seq, data FROM updates WHERE notebook = ? AND seq > ? ORDER BY seq");
const snapshotOf = db.prepare("SELECT seq, data FROM snapshots WHERE notebook = ?");
const saveSnapshot = db.prepare("INSERT OR REPLACE INTO snapshots (notebook, seq, data) VALUES (?, ?, ?)");

// one Loro document per notebook, loaded on first use
const notebooks = new Map();
const open = (name) => {
  if (!notebooks.has(name)) {
    notebooks.set(name, notebook(Loro, {
      rows: (after) => since.iterate(name, after),
      // one process, synchronous SQLite: no two inserts race for a number
      append: (data) => { const seq = lastSeq.get(name).seq + 1; insert.run(name, seq, data); return seq; },
      snapshot: () => snapshotOf.get(name) ?? null,
      saveSnapshot: (seq, data) => saveSnapshot.run(name, seq, data),
    }, { snapshotEvery: Number(process.env.SNAPSHOT_EVERY) || undefined }));
  }
  return notebooks.get(name);
};

// the notebook name also names a directory: keep it to plain characters
const NOTEBOOK = /^[A-Za-z0-9_-]{1,64}$/;
const tokenOk = (given) => {
  const a = Buffer.from(given ?? ""), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ---- updates: one room of sockets per notebook

const rooms = new Map(); // notebook -> Set of sockets

function onMessage(ws, name, message, isBinary) {
  const nb = open(name);
  if (!isBinary) {
    const msg = JSON.parse(message.toString());
    if (msg.type === "hello") for (const out of nb.hello(msg)) ws.send(out);
    return;
  }
  const { frame, ack } = nb.update(message.readUInt32BE(0), message.subarray(4));
  for (const other of rooms.get(name)) if (other !== ws && other.readyState === other.OPEN) other.send(frame);
  ws.send(ack);
}

// ---- images: content-addressed, so a PUT never changes an existing one

const BLOB = /^\/blob\/([0-9a-f]{64}\.(png|jpg|gif|webp))$/;
const TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function blob(req, res, name, ext, notebook) {
  const dir = path.join(DATA, "blobs", notebook), file = path.join(dir, name);
  if (req.method === "PUT") {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_BLOB) req.destroy(); else chunks.push(c); });
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      if (`${crypto.createHash("sha256").update(bytes).digest("hex")}.${ext}` !== name) {
        res.writeHead(400, CORS).end("hash mismatch");
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
      res.writeHead(204, CORS).end();
    });
    return;
  }
  if (!fs.existsSync(file)) { res.writeHead(404, CORS).end("not found"); return; }
  res.writeHead(200, { ...CORS, "Content-Type": TYPES[ext], "Cache-Control": "private, max-age=31536000, immutable" });
  fs.createReadStream(file).pipe(res);
}

// ---- the server

const wss = new WebSocketServer({ noServer: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, CORS).end(); return; }
  const isBlob = BLOB.exec(url.pathname);
  if (!isBlob) { res.writeHead(404).end("scratch sync"); return; }
  if (!tokenOk(url.searchParams.get("token"))) { res.writeHead(401, CORS).end("unauthorized"); return; }
  const notebook = url.searchParams.get("notebook") || "main";
  if (!NOTEBOOK.test(notebook)) { res.writeHead(400, CORS).end("bad notebook name"); return; }
  blob(req, res, isBlob[1], isBlob[2], notebook);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/sync") { socket.destroy(); return; }
  const notebook = url.searchParams.get("notebook") || "main";
  wss.handleUpgrade(req, socket, head, (ws) => {
    // a browser WebSocket never sees an HTTP status, so a refused upgrade
    // looks like a dropped network: accept, then close with 4001, which the
    // app reads as "the token is wrong" (e.g. after a rotation)
    if (!tokenOk(url.searchParams.get("token"))) { ws.close(4001, "unauthorized"); return; }
    if (!NOTEBOOK.test(notebook)) { ws.close(4000, "bad notebook name"); return; }
    if (!rooms.has(notebook)) rooms.set(notebook, new Set());
    rooms.get(notebook).add(ws);
    ws.on("message", (message, isBinary) => {
      try { onMessage(ws, notebook, message, isBinary); }
      catch (e) { console.error(e); ws.close(1011, "server error"); }
    });
    ws.on("close", () => rooms.get(notebook).delete(ws));
  });
});

server.listen(PORT, () => console.log(`scratch sync on ws://localhost:${PORT}/sync, data in ${DATA}`));
