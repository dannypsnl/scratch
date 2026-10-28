// The update log beside the snapshot (persist.js; read by mcp/server.mjs
// too): each Loro update as [u32 length, big-endian][bytes]. A last frame
// cut short (a crash while appending) is left out.

export function logFrame(bytes) {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}
export function readLog(buf) {
  const bytes = new Uint8Array(buf), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let at = 0; at + 4 <= bytes.length;) {
    const n = view.getUint32(at);
    if (at + 4 + n > bytes.length) break;
    out.push(bytes.slice(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
}
