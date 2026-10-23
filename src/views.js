import { allTasks, getViews, saveViews, updateBlockAttrs } from "./store.js";
import { compileFilter } from "./filter.js";
import { taskItem } from "./taskitem.js";
import { withTask } from "./outline.js";
import { md, weekday, today } from "./dates.js";
import { pageLabel } from "./taskitem.js";
import { place } from "./popover.js";
import { t as tr } from "./i18n.js";

// Saved views over all tasks, after GitHub Projects: each view is a filter,
// a grouping and a layout (list or board).

const defaultViews = () => [
  { name: tr("views.defaults")[0], filter: "-status:done", layout: "list", group: "status" },
  { name: tr("views.defaults")[1], filter: "", layout: "board", group: "none" },
  { name: tr("views.defaults")[2], filter: "has:deadline -status:done", layout: "list", group: "deadline" },
];

const STATUS_ORDER = ["doing", "todo", "done"];
const STATUS_NAME = { todo: "TODO", doing: "DOING", done: "DONE" };

const byDeadlineThenDate = (a, b) =>
  (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || (b.date ?? "").localeCompare(a.date ?? "");

function groups(tasks, group) {
  switch (group) {
    case "status":
      return STATUS_ORDER.map((s) => [STATUS_NAME[s], tasks.filter((t) => t.task === s)]);
    case "date": // older saved views
    case "page": {
      // journal days newest first, then named pages by title
      const pages = [...new Set(tasks.map((t) => t.page))].sort((a, b) => {
        const da = tasks.find((t) => t.page === a).date, db = tasks.find((t) => t.page === b).date;
        if (da && db) return db.localeCompare(da);
        if (da || db) return da ? -1 : 1;
        return pageLabel(a).localeCompare(pageLabel(b));
      });
      return pages.map((p) => [pageLabel(p), tasks.filter((t) => t.page === p)]);
    }
    case "deadline": {
      const ds = [...new Set(tasks.map((t) => t.deadline ?? ""))].sort((a, b) => (a || "9999").localeCompare(b || "9999"));
      return ds.map((d) => [d ? tr("views.deadlineGroup", md(d), weekday(d)) : tr("views.noDeadline"), tasks.filter((t) => (t.deadline ?? "") === d)]);
    }
    default:
      return [["", tasks]];
  }
}

function labelsFor(t) {
  if (t.deadline && t.deadline < today() && t.task !== "done") return [{ text: tr("views.overdue"), cls: "overdue" }];
  if (t.completed) return [{ text: tr("views.completedOn", md(t.completed)), cls: "completed" }];
  return [];
}

export function renderTasks(root, ctx) {
  const views = getViews() ?? defaultViews();
  let active = Math.min(ctx.state.activeView ?? 0, views.length - 1);
  const v = views[active];
  const persist = () => saveViews(views);

  root.innerHTML = `
    <div class="tasks">
      <nav class="view-tabs"></nav>
      <div class="view-bar">
        <label class="vfilter-wrap"><span class="icon">⌕</span><input class="vfilter" placeholder="${tr("views.filter")}" spellcheck="false"></label>
        <div class="seg">
          <button data-layout="list">${tr("views.list")}</button><button data-layout="board">${tr("views.board")}</button>
        </div>
        <select class="vgroup"><option value="status">${tr("views.byStatus")}</option><option value="page">${tr("views.byPage")}</option><option value="deadline">${tr("views.byDeadline")}</option><option value="none">${tr("views.noGroup")}</option></select>
      </div>
      <div class="view-body"></div>
    </div>`;

  // ---- view tabs: the active one has a ⋯ menu; double-click renames ----
  const tabs = root.querySelector(".view-tabs");
  const rename = (tab) => {
    const input = document.createElement("input");
    input.className = "vrename";
    input.value = v.name;
    tab.replaceWith(input);
    input.focus();
    input.select();
    const done = (keep) => { if (keep) { v.name = input.value.trim() || tr("page.untitled"); persist(); } ctx.render(); };
    input.onkeydown = (e) => { if (e.key === "Enter") done(true); else if (e.key === "Escape") done(false); };
    input.onblur = () => done(true);
  };
  views.forEach((view, i) => {
    const tab = document.createElement("div");
    tab.className = "vtab" + (i === active ? " active" : "");
    const b = document.createElement("button");
    b.textContent = view.name;
    b.onclick = () => { if (i !== active) { ctx.state.activeView = i; ctx.render(); } };
    if (i === active) b.ondblclick = () => rename(tab);
    tab.append(b);
    if (i === active) {
      const more = document.createElement("button");
      more.className = "vmore";
      more.textContent = "⋯";
      more.onclick = () => openViewMenu(more, {
        rename: () => rename(tab),
        duplicate: () => { views.splice(active + 1, 0, { ...v, name: tr("views.copy", v.name) }); persist(); ctx.state.activeView = active + 1; ctx.render(); },
        remove: views.length > 1 ? () => { views.splice(active, 1); persist(); ctx.state.activeView = Math.max(0, active - 1); ctx.render(); } : null,
      });
      tab.append(more);
    }
    tabs.append(tab);
  });
  const add = document.createElement("button");
  add.className = "vadd";
  add.textContent = "+";
  add.title = tr("views.new");
  add.onclick = () => {
    views.push({ name: tr("views.newName"), filter: "-status:done", layout: "list", group: "status" });
    persist();
    ctx.state.activeView = views.length - 1;
    ctx.render();
  };
  tabs.append(add);

  // ---- toolbar ----
  const filter = root.querySelector(".vfilter");
  const group = root.querySelector(".vgroup");
  filter.value = v.filter;
  group.value = v.group;
  group.hidden = v.layout === "board";
  filter.oninput = () => { v.filter = filter.value; persist(); body(); };
  group.onchange = () => { v.group = group.value; persist(); body(); };
  for (const b of root.querySelectorAll(".seg button")) {
    b.classList.toggle("active", b.dataset.layout === v.layout);
    b.onclick = () => { if (v.layout !== b.dataset.layout) { v.layout = b.dataset.layout; persist(); ctx.render(); } };
  }

  const bodyEl = root.querySelector(".view-body");
  const itemCtx = {
    ...ctx,
    rerender(focusId) {
      body();
      bodyEl.querySelector(`.task-item[data-id="${focusId}"]`)?.focusEditor();
    },
  };

  function body() {
    ctx.untrack();
    bodyEl.replaceChildren();
    const pred = compileFilter(v.filter);
    const tasks = allTasks().filter(pred).sort(byDeadlineThenDate);
    if (v.layout === "board") return board(tasks);
    for (const [title, list] of groups(tasks, v.group)) {
      if (!list.length) continue;
      const sec = document.createElement("section");
      sec.className = "group";
      if (title) sec.innerHTML = `<h3>${title}<span class="count">${list.length}</span></h3>`;
      for (const t of list) sec.append(taskItem(t, itemCtx, labelsFor(t)));
      bodyEl.append(sec);
    }
    if (!tasks.length) bodyEl.innerHTML = `<p class="empty">${tr("views.empty")}</p>`;
  }

  function board(tasks) {
    const cols = document.createElement("div");
    cols.className = "board";
    for (const s of ["todo", "doing", "done"]) {
      const col = document.createElement("section");
      col.className = `column col-${s}`;
      const list = tasks.filter((t) => t.task === s);
      col.innerHTML = `<h3>${STATUS_NAME[s]}<span class="count">${list.length}</span></h3>`;
      for (const t of list) {
        const card = taskItem(t, itemCtx, labelsFor(t));
        const handle = document.createElement("span");
        handle.className = "drag";
        handle.textContent = "⠿";
        handle.draggable = true;
        handle.ondragstart = (e) => { e.dataTransfer.setData("text/task-id", t.id); };
        card.prepend(handle);
        col.append(card);
      }
      col.ondragover = (e) => { e.preventDefault(); col.classList.add("over"); };
      col.ondragleave = () => col.classList.remove("over");
      col.ondrop = (e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/task-id");
        if (id) updateBlockAttrs(id, (a) => (a.task === s ? a : withTask(a, s)));
        body();
      };
      cols.append(col);
    }
    bodyEl.append(cols);
  }

  body();
}

// Small menu under a view's ⋯: rename, duplicate, delete (not the last view).
function openViewMenu(anchor, actions) {
  document.querySelector(".view-menu")?.remove();
  const box = document.createElement("div");
  box.className = "palette view-menu";
  const items = [["views.rename", actions.rename], ["views.duplicate", actions.duplicate], ["views.delete", actions.remove]];
  for (const [key, fn] of items) {
    if (!fn) continue;
    const b = document.createElement("button");
    b.textContent = tr(key);
    if (key === "views.delete") b.className = "danger";
    b.onmousedown = (e) => { e.preventDefault(); box.remove(); fn(); };
    box.append(b);
  }
  document.body.append(box);
  place(box, anchor.getBoundingClientRect());
  const away = (e) => { if (!box.contains(e.target)) { box.remove(); document.removeEventListener("mousedown", away); } };
  setTimeout(() => document.addEventListener("mousedown", away));
}
