import "katex/dist/katex.min.css";
import "./style.css";
import { load, getPage, savePage, pageDates, namedPages, titleOf, findPage, createPage, getBlock, pageOfBlock, isDate, onRemote, fieldById, fieldByName } from "./store.js";
import { connect, config, configure, onStatus } from "./sync.js";
import { parseOutline, resolver } from "./outline-io.js";
import { lookup } from "./schema.js";
import { hooks } from "./editor.js";
import { renderJournal } from "./journal.js";
import { renderPage, renderPages } from "./page.js";
import { renderAgenda } from "./agenda.js";
import { renderTasks } from "./views.js";
import { today, addDays } from "./dates.js";
import { place } from "./popover.js";
import { applySettings, toggleSettings } from "./settings.js";
import { renderSidebar } from "./sidebar.js";
import * as Neutralino from "@neutralinojs/lib";
import { inNeutralino } from "./persist.js";
import { t } from "./i18n.js";

const app = document.querySelector("#app");
const state = { tab: "journal", date: today(), week: today(), activeView: 0, page: null, focusBlock: null };
let editors = [];

const ctx = {
  state,
  track: (view) => editors.push(view),
  untrack() { editors.forEach((v) => v.destroy()); editors = []; },
  render,
  openPage(id) {
    if (isDate(id)) { state.tab = "journal"; state.date = id; }
    else { state.tab = "page"; state.page = id; }
    render();
  },
};

// Links resolve through the store. Parsing exported text never creates
// pages: an unknown title becomes "?title" and is created when followed.
lookup.title = (id) => (id.startsWith("?") ? id.slice(1) : titleOf(id));
lookup.line = (id) => getBlock(id)?.firstChild ?? null;
// export names journal days by their ISO date, whatever the interface language
resolver.title = (id) => (isDate(id) ? id : lookup.title(id));
resolver.pageId = (title) => findPage(title) ?? "?" + title;
resolver.fieldName = (id) => fieldById(id)?.name ?? id;
resolver.fieldId = (name) => fieldByName(name)?.id ?? name;
hooks.openPage = (id) => ctx.openPage(id.startsWith("?") ? findPage(id.slice(1)) ?? createPage(id.slice(1)) : id);
hooks.openBlock = (id) => {
  const page = pageOfBlock(id);
  if (!page) return;
  state.focusBlock = id;
  ctx.openPage(page);
};

const RENDER = { journal: renderJournal, agenda: renderAgenda, tasks: renderTasks, pages: renderPages, page: renderPage };

function render() {
  ctx.untrack();
  document.querySelectorAll(".palette, .calendar").forEach((e) => e.remove());
  const tab = state.tab === "page" ? "pages" : state.tab;
  document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  RENDER[state.tab](app, ctx);
  renderSidebar(ctx);
}

// ---------- sidebar: ☰ or ⌘\ collapses it; narrow windows start collapsed ----------
const shell = document.querySelector(".app");
const narrow = window.matchMedia("(max-width: 860px)");
const setCollapsed = (on) => shell.classList.toggle("side-collapsed", on);
setCollapsed(narrow.matches);
narrow.addEventListener("change", (e) => setCollapsed(e.matches));
document.querySelector(".side-toggle").onclick = () => setCollapsed(!shell.classList.contains("side-collapsed"));
document.addEventListener("keydown", (e) => {
  if (e.key === "\\" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setCollapsed(!shell.classList.contains("side-collapsed")); }
});
// on a narrow window the sidebar floats over the page: pick something, it goes away
document.querySelector(".sidebar").addEventListener("click", (e) => {
  if (narrow.matches && e.target.closest("button[data-tab], a, [data-day]")) setCollapsed(true);
});

document.querySelectorAll(".tabs [data-tab]").forEach((b) => {
  b.onclick = () => { state.tab = b.dataset.tab; render(); };
});

// First run: a couple of pages to play with.
function seed() {
  const t = today(), y = addDays(t, -1);
  savePage(t, parseOutline([
    "- 這是今天的 journal。⌘↵ 在 TODO → DOING → DONE 之間切換，⌘⇧D 設期限",
    `- TODO 證明 AM–GM：$\\frac{a+b}{2}\\geq\\sqrt{ab}$ DEADLINE: <${addDays(t, 3)}>`,
    "  - 先看 $n=2$ 的情況",
    "  - 再用 *歸納法* 推到一般的 $n$",
    "- DOING 讀 **Mac Lane** 第三章：$A\\overset{f}{\\to}B$",
    "- 下標上標 $x_i^2$、求和 $\\sum_{k=0}^nk$、巢狀 $\\frac{1}{1+\\frac{1}{x}}$",
  ].join("\n")));
  savePage(y, parseOutline([
    "- DONE 整理 quiver 嵌入的想法",
    `- TODO 回信確認 seminar 時間 DEADLINE: <${y}>`,
  ].join("\n")));
}

// ---------- sync status + settings ----------

const statusBtn = document.querySelector(".sync-status");
onStatus((s) => {
  statusBtn.textContent = t("sync." + s.state);
  statusBtn.dataset.state = s.state;
});

statusBtn.onclick = () => {
  document.querySelector(".sync-panel")?.remove();
  const cfg = config() ?? {};
  const box = document.createElement("form");
  box.className = "sync-panel";
  box.innerHTML = `
    <label>Server<input name="url" placeholder="${t("sync.urlPlaceholder")}" spellcheck="false"></label>
    <label>Token<input name="token" type="password"></label>
    <label>Notebook<input name="notebook" placeholder="main" spellcheck="false"></label>
    <div class="row"><button type="submit">${t("sync.connect")}</button><button type="button" class="cancel">${t("cancel")}</button></div>`;
  box.url.value = cfg.url ?? "";
  box.token.value = cfg.token ?? "";
  box.notebook.value = cfg.notebook ?? "";
  box.onsubmit = (e) => {
    e.preventDefault();
    const next = { url: box.url.value.trim(), token: box.token.value, notebook: box.notebook.value.trim() || "main" };
    box.remove();
    configure(next);
  };
  box.querySelector(".cancel").onclick = () => box.remove();
  document.body.append(box);
  place(box, statusBtn.getBoundingClientRect());
  box.url.focus();
};

// Same for every text field (menus, titles, settings).
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  el.spellcheck = false;
  el.setAttribute("autocorrect", "off");
  el.setAttribute("autocapitalize", "off");
  el.setAttribute("autocomplete", "off");
});

// ---------- key help (? in the top bar, or ⌘/) ----------

function toggleHelp() {
  const open = document.querySelector(".help-panel");
  if (open) return open.remove();
  const box = document.createElement("div");
  box.className = "help-panel";
  // [description, alternatives], each alternative a list of keys pressed together
  for (const [title, rows] of t("help")) {
    const h = document.createElement("h3");
    h.textContent = title;
    box.append(h);
    for (const [desc, alts] of rows) {
      const d = document.createElement("div");
      d.className = "desc";
      d.textContent = desc;
      const k = document.createElement("div");
      k.className = "keys";
      alts.forEach((keys, i) => {
        if (i) k.insertAdjacentHTML("beforeend", `<span class="or">/</span>`);
        for (const key of keys) {
          const kbd = document.createElement("kbd");
          kbd.textContent = key;
          k.append(kbd);
        }
      });
      box.append(d, k);
    }
  }
  document.body.append(box);
  place(box, document.querySelector(".help-btn").getBoundingClientRect(), { align: "end" });
}
document.querySelector(".help-btn").onclick = toggleHelp;
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleHelp(); }
  else if (e.key === "Escape") document.querySelector(".help-panel")?.remove();
});
document.addEventListener("mousedown", (e) => {
  const panel = document.querySelector(".help-panel");
  if (panel && !panel.contains(e.target) && !e.target.closest(".help-btn")) panel.remove();
});

// Remote changes: journal and page views patch their own editor (page.js);
// list views re-render unless one of their editors is in use.
onRemote(() => {
  if (!["agenda", "tasks", "pages"].includes(state.tab)) return;
  if (document.activeElement?.closest(".task-item")) return;
  render();
});

// ---------- native menu (Neutralino on macOS) ----------
// ⌘C / ⌘V / ⌘X only work through an Edit menu whose items send the
// standard actions to the web view. ⌘A, undo and redo stay with the editor
// (a menu item would grab the key before the editor sees it).
function nativeMenu() {
  if (!inNeutralino) return;
  const sep = { text: "-" };
  Neutralino.window.setMainMenu([
    { id: "app", text: "scratch", menuItems: [
      { id: "settings", text: t("menu.settings"), shortcut: "," },
      { id: "help", text: t("menu.help"), shortcut: "/" },
      sep,
      { id: "hide", text: t("menu.hide"), action: "hide:", shortcut: "h" },
      { id: "quit", text: t("menu.quit"), action: "terminate:", shortcut: "q" },
    ] },
    { id: "edit", text: t("menu.edit"), menuItems: [
      { id: "cut", text: t("menu.cut"), action: "cut:", shortcut: "x" },
      { id: "copy", text: t("menu.copy"), action: "copy:", shortcut: "c" },
      { id: "paste", text: t("menu.paste"), action: "paste:", shortcut: "v" },
    ] },
    { id: "window", text: t("menu.window"), menuItems: [
      { id: "minimize", text: t("menu.minimize"), action: "performMiniaturize:", shortcut: "m" },
      { id: "close", text: t("menu.close"), action: "performClose:", shortcut: "w" },
    ] },
  ]);
}
if (inNeutralino) {
  Neutralino.events.on("mainMenuItemClicked", (e) => {
    if (e.detail.id === "settings") toggleSettings();
    else if (e.detail.id === "help") toggleHelp();
  });
}

await load();
applySettings(() => {
  render();
  nativeMenu();
  statusBtn.textContent = t("sync." + (statusBtn.dataset.state ?? "off"));
});
// Demo pages only for a brand-new, unsynced notebook; a synced one fills from the server.
if (!config() && pageDates().size === 0 && namedPages().length === 0) seed();
render();
nativeMenu();
connect();
window.getPage = getPage;
