import { DurableObject } from "cloudflare:workers";
import { LoroDoc, VersionVector, decodeImportBlobMeta } from "loro-crdt/bundler";
import { notebook } from "./core.js";

// Sync relay for one person's notebook: one Durable Object per notebook,
// holding the notebook as a Loro document (core.js has the protocol). Every
// update is appended to a log and broadcast to the other devices; a snapshot
// now and then saves replaying the whole log when the object wakes.

export class Notebook extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      sql.exec("CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, data BLOB NOT NULL)");
      this.nb = notebook({ LoroDoc, VersionVector, decodeImportBlobMeta }, {
        rows: (after) => sql.exec("SELECT seq, data FROM updates WHERE seq > ? ORDER BY seq", after),
        append: (data) => sql.exec("INSERT INTO updates (data) VALUES (?) RETURNING seq", data).one().seq,
        snapshot: () => sql.exec("SELECT seq, data FROM snapshot WHERE id = 1").toArray()[0] ?? null,
        saveSnapshot: (seq, data) => sql.exec("INSERT OR REPLACE INTO snapshot (id, seq, data) VALUES (1, ?, ?)", seq, data),
      });
    });
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message === "string") {
      const msg = JSON.parse(message);
      if (msg.type === "hello") for (const out of this.nb.hello(msg)) ws.send(out);
      return;
    }
    const id = new DataView(message).getUint32(0);
    const { frame, ack } = this.nb.update(id, message.slice(4));
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) other.send(frame);
    }
    ws.send(ack);
  }

  // 1005 and 1006 (no code, dropped) are reported, never sent
  async webSocketClose(ws, code, reason) {
    ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }
}

// Images live in R2, named by the SHA-256 of their bytes, under the
// notebook's name. Content-addressed, so a PUT never changes an existing one.
const BLOB = /^\/blob\/([0-9a-f]{64}\.(png|jpg|gif|webp))$/;
const TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function blob(request, env, name, ext, notebook) {
  const key = `${notebook}/${name}`;
  if (request.method === "PUT") {
    const bytes = await request.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (`${digest}.${ext}` !== name) return new Response("hash mismatch", { status: 400, headers: CORS });
    await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: TYPES[ext] } });
    return new Response(null, { status: 204, headers: CORS });
  }
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response("not found", { status: 404, headers: CORS });
  return new Response(obj.body, {
    headers: { ...CORS, "Content-Type": TYPES[ext], "Cache-Control": "private, max-age=31536000, immutable" },
  });
}

// Single user: one shared token (a Worker secret, SYNC_TOKEN). The notebook
// name selects the Durable Object (and the R2 prefix), so notebooks never mix.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const isBlob = BLOB.exec(url.pathname);
    if (url.pathname !== "/sync" && !isBlob) return new Response("scratch sync", { status: 404 });
    if (!env.SYNC_TOKEN || url.searchParams.get("token") !== env.SYNC_TOKEN) {
      // A browser WebSocket never sees an HTTP status, so a refused upgrade
      // looks like a dropped network. Accept it and close with 4001 instead,
      // which the app reads as "the token is wrong" (e.g. after a rotation).
      if (request.headers.get("Upgrade") === "websocket") {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        server.close(4001, "unauthorized");
        return new Response(null, { status: 101, webSocket: client });
      }
      return new Response("unauthorized", { status: 401, headers: CORS });
    }
    const notebook = url.searchParams.get("notebook") || "main";
    if (isBlob) return blob(request, env, isBlob[1], isBlob[2], notebook);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    return env.NOTEBOOK.getByName(notebook).fetch(request);
  },
};
