import { persistence } from "./persist.js";
import { getMeta, saveMeta } from "./store.js";
import { config, unauthorized } from "./sync.js";

// Images are named by the SHA-256 of their bytes ("<hash>.png"): the same
// picture pasted twice is stored once, and a name never changes meaning.
// A copy lives in the local store; with sync configured it is also uploaded
// to the server (R2) and fetched from there by devices that lack it.
// Uploads that fail wait in meta.pendingImages until the next connect.

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
export const isImageFile = (file) => file && file.type in EXT;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// https://host/blob/<name>?token=…&notebook=…, from the sync settings
function blobURL(name) {
  const cfg = config();
  if (!cfg?.url) return null;
  const url = new URL(cfg.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `/blob/${name}`;
  url.search = "";
  url.searchParams.set("token", cfg.token ?? "");
  url.searchParams.set("notebook", cfg.notebook || "main");
  return url;
}

async function upload(name, bytes) {
  const url = blobURL(name);
  if (!url) return false;
  try {
    const res = await fetch(url, { method: "PUT", body: bytes, headers: { "Content-Type": TYPE[name.split(".").pop()] } });
    if (res.status === 401) unauthorized();
    return res.ok;
  } catch {
    return false;
  }
}

function queue(name, add) {
  const pending = new Set(getMeta().pendingImages ?? []);
  if (add) pending.add(name);
  else pending.delete(name);
  saveMeta({ pendingImages: [...pending] });
}

// Store a pasted / dropped file; returns its name.
export async function addImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = `${hex(await crypto.subtle.digest("SHA-256", bytes))}.${EXT[file.type]}`;
  await persistence.saveImage(name, bytes);
  urls.set(name, Promise.resolve(URL.createObjectURL(new Blob([bytes], { type: file.type }))));
  if (!(await upload(name, bytes))) queue(name, true);
  return name;
}

// Retry uploads that failed (called when sync connects).
export async function flushUploads() {
  for (const name of getMeta().pendingImages ?? []) {
    const bytes = await persistence.loadImage(name);
    if (!bytes) { queue(name, false); continue; }
    if (await upload(name, bytes)) queue(name, false);
  }
}

// Object URL for an image: local copy, else download (and keep) it.
const urls = new Map();
export function imageURL(name) {
  if (!urls.has(name)) {
    urls.set(name, (async () => {
      let bytes = await persistence.loadImage(name);
      if (!bytes) {
        const url = blobURL(name);
        if (!url) return null;
        const res = await fetch(url);
        if (res.status === 401) unauthorized();
        if (!res.ok) return null;
        bytes = new Uint8Array(await res.arrayBuffer());
        await persistence.saveImage(name, bytes);
      }
      return URL.createObjectURL(new Blob([bytes], { type: TYPE[name.split(".").pop()] }));
    })().catch(() => null));
  }
  return urls.get(name);
}
