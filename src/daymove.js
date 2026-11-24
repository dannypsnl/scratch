import { Plugin, PluginKey } from "prosemirror-state";
import { openCalendar } from "./calendar.js";
import { heldIds, findBlock } from "./blockselect.js";
import { isDate } from "./store.js";
import { t } from "./i18n.js";

const key = new PluginKey("dayMove");

const ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/></svg>`;

export const moveToDay = (state) => key.get(state)?.spec.dayMove ?? null;

export function dayAt(state, x, y) {
  const target = moveToDay(state);
  if (!target) return null;
  return [...document.querySelectorAll("[data-drop-day]")].find((el) => {
    const r = el.getBoundingClientRect();
    return el.dataset.dropDay !== target.page && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  }) ?? null;
}

export const dayMove = (page, move) => new Plugin({
  key,
  dayMove: { page, move },
  view(view) {
    const button = document.body.appendChild(Object.assign(document.createElement("button"), {
      type: "button", className: "move-day", title: t("block.moveToDay"), innerHTML: ICON, hidden: true,
    }));
    let id = null, timer = null;
    const pickerOpen = () => document.querySelector(".calendar")?.anchor === button;
    const hide = () => { clearTimeout(timer); button.hidden = true; };
    const hideSoon = () => { clearTimeout(timer); timer = setTimeout(() => (pickerOpen() ? hideSoon() : hide()), 250); };
    const over = (e) => {
      const bullet = e.target.closest?.(".pm-bullet");
      if (!bullet || !view.dom.contains(bullet) || pickerOpen()) return;
      clearTimeout(timer);
      id = view.state.doc.nodeAt(view.posAtDOM(bullet.parentElement.querySelector(":scope > .pm-body"), 0) - 1)?.attrs.id ?? null;
      button.hidden = false;
      const r = bullet.getBoundingClientRect();
      button.style.left = `${r.left - button.offsetWidth}px`;
      button.style.top = `${r.top + (r.height - button.offsetHeight) / 2}px`;
    };
    const out = (e) => { if (e.target.closest?.(".pm-bullet")) hideSoon(); };
    const scrolled = () => { if (!pickerOpen()) hide(); };
    button.onmouseenter = () => clearTimeout(timer);
    button.onmouseleave = hideSoon;
    button.onmousedown = (e) => e.preventDefault();
    button.onclick = () => {
      const at = id && findBlock(view.state.doc, id);
      if (at == null) return hide();
      const ids = heldIds(view.state, at);
      openCalendar(button, isDate(page) ? page : undefined, undefined, (day) => {
        hide();
        if (day !== page) move(ids, day);
      }, { align: "start" });
    };
    view.dom.addEventListener("mouseover", over);
    view.dom.addEventListener("mouseout", out);
    view.dom.addEventListener("mousedown", hide, true);
    addEventListener("scroll", scrolled, true);
    return {
      update(v, prev) { if (v.state.doc !== prev.doc && !pickerOpen()) hide(); },
      destroy() {
        clearTimeout(timer);
        view.dom.removeEventListener("mouseover", over);
        view.dom.removeEventListener("mouseout", out);
        view.dom.removeEventListener("mousedown", hide, true);
        removeEventListener("scroll", scrolled, true);
        if (pickerOpen()) document.querySelector(".calendar").close();
        button.remove();
      },
    };
  },
});
