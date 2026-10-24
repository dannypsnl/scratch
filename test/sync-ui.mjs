// Sync in WebKit: two devices (browser contexts, each with its own storage)
// on a local relay (sync/server.mjs). A device closed right after an update
// arrives, before its snapshot is saved, must still have the update when it
// opens again; a device that lost an update on the way must catch up when
// the next one cannot apply; edits made on both while one is offline must
// end up on both. Starts its own Vite server.
//
//   npm run test:ui
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { webkit } from "playwright-core";

const root = new URL("..", import.meta.url).pathname;
const PORT = 19000 + Math.floor(Math.random() * 1000), TOKEN = "test-token";
const SYNC = { url: `ws://localhost:${PORT}/sync`, token: TOKEN, notebook: "main" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-sync-ui-"));
const relay = spawn(process.execPath, [path.join(root, "sync/server.mjs")], {
  env: { ...process.env, SYNC_TOKEN: TOKEN, PORT: String(PORT), DATA_DIR: path.join(tmp, "relay") },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => relay.stdout.once("data", resolve));

const server = await createServer({ logLevel: "error", server: { port: 5196, hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await webkit.launch();

const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const DAY = "2025-05-01";

// a device: a browser context (its own IndexedDB) and the app open in it
async function device() {
  const ctx = await browser.newContext();
  const d = { ctx, pg: null, drop: false };
  // between the app and the relay: d.drop loses the next update on its way in
  await ctx.routeWebSocket(/\/sync/, (ws) => {
    const relay = ws.connectToServer();
    relay.onMessage((m) => { if (d.drop && typeof m !== "string") { d.drop = false; return; } ws.send(m); });
    ws.onMessage((m) => relay.send(m));
  });
  d.open = async () => {
    d.pg = await ctx.newPage();
    d.pg.on("pageerror", (e) => check(false, `page error: ${e}`));
    await d.pg.goto(url);
    await d.pg.waitForFunction(() => window.view);
  };
  // quit with no chance to save: no beforeunload, pending timers dropped
  d.kill = () => d.pg.close({ runBeforeUnload: false });
  d.eval = (fn, arg) => d.pg.evaluate(fn, arg);
  d.configure = (sync) => d.eval(async (sync) => (await import("/src/sync.js")).configure(sync), sync);
  d.synced = () => d.pg.waitForFunction(() => document.querySelector(".sync-status")?.dataset.state === "synced", null, { timeout: 5000 });
  d.write = (lines, day = DAY) => d.eval(async ({ day, lines }) => {
    const store = await import("/src/store.js");
    const IO = await import("/src/outline-io.js");
    store.savePage(day, IO.parseOutline(lines.join("\n")));
    store.flush();
  }, { day, lines });
  d.text = (day = DAY) => d.eval((day) => window.getPage(day)?.textContent ?? "", day);
  d.has = async (s, ms = 4000, day = DAY) => {
    for (let k = 0; k < ms / 50; k++) { if ((await d.text(day)).includes(s)) return true; await new Promise((r) => setTimeout(r, 50)); }
    return false;
  };
  return d;
}

const a = await device(), b = await device();
await a.open(); await a.configure(SYNC); await a.synced();
await b.open(); await b.configure(SYNC); await b.synced();

// 1. closed right after an update arrives
await b.write(["- 第一"]);
check(await a.has("第一"), "the other device's edit arrives");
await a.kill();
await a.open(); await a.synced();
check(await a.has("第一"), "closed before saving, opened again: the edit is still there");

// 2. an update lost on the way: the next one cannot apply without it
a.drop = true;
await b.write(["- 第一", "- 第二"]);
check(!(await a.has("第二", 500)), "(set up: the update with 第二 never reaches the device)");
await b.write(["- 第一", "- 第二 改過", "- 第三"]);
check(await a.has("第三", 6000), "the next update cannot apply, the device asks again: it shows");
check(await a.has("第二 改過"), "and the lost one with it");

// 3. both write while one is offline (a relay that is not there)
const DAY2 = "2025-05-02";
await a.configure({ ...SYNC, url: `ws://localhost:${PORT + 1}/sync` });
await a.write(["- A 離線時寫的"], DAY2);
await b.write(["- 第一", "- 第二 改過", "- 第三", "- B 同時寫的"]);
await a.configure(SYNC); await a.synced();
check(await a.has("B 同時寫的"), "back online, the device gets what was written meanwhile");
check(await b.has("A 離線時寫的", 4000, DAY2), "and the other device gets what it wrote offline");

await browser.close();
await server.close();
relay.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
