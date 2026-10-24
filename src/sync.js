import { VersionVector } from "loro-crdt/base64";
import { doc } from "./loro.js";
import { flush, importRemote, getMeta, saveMeta } from "./store.js";
import { flushUploads } from "./images.js";

// Client side of the sync relay (sync/src/core.js has the protocol).
//
// Nothing about progress is kept. On connect the device says what its
// document has, as a Loro version vector, and gets exactly what it lacks;
// the reply carries the server's version, and what the server lacks is sent
// from it, which covers edits made offline. An update that cannot apply (it
// waits on changes this device lacks) is answered with another hello, and an
// ack saying what the server needs with that.
//
// Live, every local Loro change is sent as it is committed and acked by id.

const statusListeners = new Set();
export const onStatus = (fn) => { statusListeners.add(fn); fn(status); return () => statusListeners.delete(fn); };
let status = { state: "off" }; // off | connecting | syncing | synced | offline | unauthorized
const setStatus = (s) => { status = s; for (const fn of statusListeners) fn(s); };

let ws = null;
let retry = 0;
let timer = null;
let nextId = 1;
const inflight = new Set(); // ids of updates sent and not yet acked

const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const config = () => getMeta().sync ?? null;

export function configure(sync) {
  saveMeta({ sync });
  connect();
}

// everything this device has that a document at `from` lacks (an update
// with nothing in it is still a few bytes: compare instead)
function sendNewer(from) {
  if (!from) return send(doc.export({ mode: "update" }));
  if (![0, -1].includes(doc.oplogVersion().compare(from))) send(doc.export({ mode: "update", from }));
}

export function connect() {
  clearTimeout(timer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  const cfg = config();
  if (!cfg?.url) return setStatus({ state: "off" });

  const url = new URL(cfg.url);
  url.searchParams.set("token", cfg.token ?? "");
  if (cfg.notebook) url.searchParams.set("notebook", cfg.notebook);
  setStatus({ state: "connecting" });
  const sock = new WebSocket(url);
  sock.binaryType = "arraybuffer";
  ws = sock;
  // a hello not yet answered: what arrives meanwhile may not apply yet
  let asking = false;
  const hello = () => {
    asking = true;
    sock.send(JSON.stringify({ type: "hello", vv: b64(doc.oplogVersion().encode()) }));
  };
  const version = (s) => (s ? VersionVector.decode(unb64(s)) : undefined);

  sock.onopen = () => {
    retry = 0;
    setStatus({ state: "syncing" });
    flush();
    hello();
  };

  sock.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.type === "ack") {
        inflight.delete(msg.id);
        if (msg.need) sendNewer(version(msg.need));
        if (!inflight.size && status.state === "synced") setStatus({ state: "synced" });
      } else if (msg.type === "synced") {
        asking = false;
        // (a relay from before version vectors sends none: send everything)
        sendNewer(version(msg.vv));
        setStatus({ state: "synced" });
        flushUploads();
      }
      return;
    }
    const view = new DataView(ev.data);
    if (view.getUint8(0) !== 1) return;
    if (!importRemote(new Uint8Array(ev.data, 9)) && !asking) hello();
  };

  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    inflight.clear();
    // a wrong token stays wrong: wait for a new one instead of retrying
    if (ev.code === 4001) return setStatus({ state: "unauthorized" });
    setStatus({ state: "offline" });
    timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
  };
  sock.onerror = () => {}; // onclose follows
}

// The blob routes answer 401 for the same reason.
export function unauthorized() {
  clearTimeout(timer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  setStatus({ state: "unauthorized" });
}

function send(update) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !update.length) return;
  const id = nextId++;
  inflight.add(id);
  const frame = new Uint8Array(4 + update.length);
  new DataView(frame.buffer).setUint32(0, id);
  frame.set(update, 4);
  ws.send(frame);
}

// Local commits go out as they happen; while offline they wait in the
// snapshot, and the next connect sends whatever the server lacks.
doc.subscribeLocalUpdates((update) => send(update));
