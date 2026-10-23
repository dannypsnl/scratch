import { DurableObject } from "cloudflare:workers";

// Sync relay for one person's notebook.
//
// The server never looks inside the data: every Loro update a device sends is
// appended to a log with a sequence number and broadcast to the other
// devices. A device that (re)connects says the last sequence it has seen and
// gets everything after it. Loro imports are idempotent, so resending is safe.
//
// Wire format
//   client -> server  text   {"type":"hello","since":<seq>}
//                     binary [u32 id][loro update]          (acked by id)
//   server -> client  binary [u8 1][u64 seq][loro update]
//                     text   {"type":"ack","id":<id>,"seq":<seq>}
//                     text   {"type":"synced","seq":<latest seq>}

export class Notebook extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)",
      );
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
      if (msg.type === "hello") this.sendSince(ws, Number(msg.since) || 0);
      return;
    }
    const id = new DataView(message).getUint32(0);
    const update = message.slice(4);
    const { seq } = this.ctx.storage.sql
      .exec("INSERT INTO updates (data) VALUES (?) RETURNING seq", update)
      .one();
    const frame = updateFrame(seq, update);
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) other.send(frame);
    }
    ws.send(JSON.stringify({ type: "ack", id, seq }));
  }

  async webSocketClose(ws, code, reason) {
    ws.close(code, reason);
  }

  sendSince(ws, since) {
    let last = since;
    for (const row of this.ctx.storage.sql.exec("SELECT seq, data FROM updates WHERE seq > ? ORDER BY seq", since)) {
      ws.send(updateFrame(row.seq, row.data));
      last = row.seq;
    }
    ws.send(JSON.stringify({ type: "synced", seq: last }));
  }
}

function updateFrame(seq, update) {
  const bytes = new Uint8Array(update);
  const frame = new Uint8Array(9 + bytes.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, 1);
  view.setBigUint64(1, BigInt(seq));
  frame.set(bytes, 9);
  return frame;
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
