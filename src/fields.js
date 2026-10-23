import { place } from "./popover.js";
import { parseDate } from "./deadline.js";
import { newId } from "./outline-io.js";
import { longDate, md } from "./dates.js";
import { t } from "./i18n.js";

// Fields are defined on a tag page: { id, name, type, options }.
// type: "select" (one of options), "text", "url", "date" (YYYY-MM-DD).
export const FIELD_TYPES = ["select", "text", "url", "date"];

export function displayValue(field, value) {
  if (value === undefined || value === null || value === "") return null;
  if (field.type === "date") return md(value);
  if (field.type === "url") {
    try { return new URL(value).host; } catch { return value; }
  }
  return String(value);
}

function popover(anchor, cls) {
  document.querySelector(".field-pop")?.remove();
  const box = document.createElement("div");
  box.className = `palette field-pop ${cls}`;
  document.body.append(box);
  place(box, anchor.getBoundingClientRect());
  const close = () => { box.remove(); document.removeEventListener("mousedown", away); };
  const away = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener("mousedown", away));
  box.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
  return { box, close };
}

// Add or edit a field definition. onSave(field); onDelete() when editing.
export function openFieldEditor(anchor, field, { onSave, onDelete }) {
  const { box, close } = popover(anchor, "field-def");
  const f = field ? { ...field, options: [...(field.options ?? [])] } : { id: "f-" + newId(), name: "", type: "select", options: [] };
  box.innerHTML = `
    <input class="fname" placeholder="${t("fields.name")}">
    <div class="ftypes">${FIELD_TYPES.map((ty) => `<button type="button" data-type="${ty}">${t("fields.type." + ty)}</button>`).join("")}</div>
    <div class="foptions"><div class="chips"></div><input class="fopt-new" placeholder="${t("fields.addOption")}"></div>
    <div class="row">
      ${field ? `<button type="button" class="danger fdel">${t("fields.delete")}</button>` : ""}
      <button type="button" class="fsave">${t("fields.save")}</button>
    </div>`;
  const name = box.querySelector(".fname");
  const options = box.querySelector(".foptions");
  const chips = options.querySelector(".chips");
  const optNew = options.querySelector(".fopt-new");
  name.value = f.name;
  const drawOptions = () => {
    chips.replaceChildren(...f.options.map((o, i) => {
      const chip = document.createElement("span");
      chip.className = "opt-chip";
      chip.textContent = o;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.onclick = () => { f.options.splice(i, 1); drawOptions(); };
      chip.append(x);
      return chip;
    }));
  };
  // Enter in the option box adds what was typed; on an empty box it saves
  const addOption = () => {
    const o = optNew.value.trim();
    if (!o) return false;
    if (!f.options.includes(o)) f.options.push(o);
    optNew.value = "";
    drawOptions();
    return true;
  };
  drawOptions();
  const drawType = () => {
    for (const b of box.querySelectorAll(".ftypes button")) b.classList.toggle("active", b.dataset.type === f.type);
    options.hidden = f.type !== "select";
  };
  box.querySelectorAll(".ftypes button").forEach((b) => { b.onclick = () => { f.type = b.dataset.type; drawType(); }; });
  drawType();
  const save = () => {
    f.name = name.value.trim();
    if (!f.name) return name.focus();
    if (f.type === "select") addOption();
    else f.options = [];
    close();
    onSave(f);
  };
  box.querySelector(".fsave").onclick = save;
  box.querySelector(".fdel")?.addEventListener("click", () => { close(); onDelete(); });
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    if (e.target === optNew && addOption()) return;
    if (e.target === name && f.type === "select") return optNew.focus();
    save();
  });
  optNew.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !optNew.value && f.options.length) { f.options.pop(); drawOptions(); }
  });
  name.focus();
}

// Pick or type a value for one field. onSave(value) — null clears it.
// For a select, typing a name that is not an option yet adds it through
// onAddOption(name) and picks it.
export function openValueEditor(anchor, field, value, onSave, onAddOption) {
  const { box, close } = popover(anchor, "field-value");
  const done = (v) => { close(); onSave(v); };
  if (field.type === "select") {
    for (const opt of field.options ?? []) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt;
      if (opt === value) b.className = "active";
      b.onclick = () => done(opt);
      box.append(b);
    }
    if (onAddOption) {
      const input = document.createElement("input");
      input.placeholder = t("fields.addOption");
      box.append(input);
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        const o = input.value.trim();
        if (!o) return;
        if (!(field.options ?? []).includes(o)) onAddOption(o);
        done(o);
      });
      setTimeout(() => input.focus());
    } else if (!(field.options ?? []).length) box.insertAdjacentHTML("beforeend", `<div class="ask">${t("fields.noOptions")}</div>`);
  } else {
    const input = document.createElement("input");
    input.placeholder = field.type === "date" ? t("deadline.placeholder") : field.type === "url" ? "https://…" : field.name;
    input.value = field.type === "date" && value ? longDate(value) : value ?? "";
    box.append(input);
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const raw = input.value.trim();
      if (!raw) return done(null);
      if (field.type === "date") {
        const d = parseDate(raw);
        if (d) done(d);
      } else done(raw);
    });
    setTimeout(() => { input.focus(); input.select(); });
  }
  if (value !== undefined && value !== null && value !== "") {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "danger";
    clear.textContent = t("fields.clear");
    clear.onclick = () => done(null);
    box.append(clear);
  }
}
