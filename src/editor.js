import { EditorState, TextSelection, Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Fragment } from "prosemirror-model";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { schema } from "./schema.js";
import { parseMath, serializeMath } from "./latex.js";
import { parseInline, parseOutline, serializeInline, serializeOutline } from "./outline-io.js";
import { horizontal, vertical, term, selectTerm, selectStep, selectEdge, formula, selectionShape, xArrowsToOverset, backspace, deleteForward, exitMath, inMath, typeInMath, insertMath, navGuard, besideSpecial } from "./nav.js";
import { splitBlock, indent, outdent, joinBackward, cycleTask, selectAll, setFold, newTopBlock, blockIds, outlineDecorations } from "./outline.js";
import { blockDrag } from "./drag.js";
import { openPalette } from "./palette.js";
import { openPicker } from "./picker.js";
import { addImage, imageURL, isImageFile } from "./images.js";
import { newId } from "./outline-io.js";
import * as Neutralino from "@neutralinojs/lib";
import { inNeutralino } from "./persist.js";
import { findPage, createPage, namedPages, pageDates, titleOf, isDate } from "./store.js";
import { openDeadlinePicker } from "./deadline.js";
import { mathDecorations } from "./decorations.js";
import { notationHint } from "./notation.js";
import { scriptStacking } from "./stack.js";
import { t } from "./i18n.js";

const T = schema.nodes;

// Formula keys first: each returns false outside a formula and falls through.
const mathKeys = keymap({
  ArrowLeft: horizontal(-1),
  ArrowRight: horizontal(1),
  "Alt-ArrowLeft": term(-1),
  "Alt-ArrowRight": term(1),
  "Shift-ArrowLeft": selectStep(-1),
  "Shift-ArrowRight": selectStep(1),
  "Shift-Mod-ArrowLeft": selectEdge(-1),
  "Shift-Mod-ArrowRight": selectEdge(1),
  "Shift-Alt-ArrowLeft": selectTerm(-1),
  "Shift-Alt-ArrowRight": selectTerm(1),
  "Mod-ArrowLeft": formula(-1),
  "Mod-ArrowRight": formula(1),
  ArrowUp: vertical(-1),
  ArrowDown: vertical(1),
  Backspace: backspace,
  Delete: deleteForward,
  Enter: exitMath,
  Escape: exitMath,
});

const outlineKeys = keymap({
  Enter: splitBlock,
  Tab: indent,
  "Shift-Tab": outdent,
  "Mod-Shift-Enter": newTopBlock,
  Backspace: joinBackward,
  "Mod-Enter": cycleTask,
  "Mod-a": selectAll,
  "Mod-ArrowUp": setFold(true),
  "Mod-ArrowDown": setFold(false),
  "Mod-Shift-d": (_state, _dispatch, view) => { if (view) openDeadlinePicker(view); return true; },
  "Mod-b": toggleMark(schema.marks.strong),
  "Mod-i": toggleMark(schema.marks.em),
  "Mod-u": toggleMark(schema.marks.underline),
  "Mod-Shift-x": toggleMark(schema.marks.strike),
  "Mod-Shift-h": toggleMark(schema.marks.highlight),
  "Mod-e": toggleMark(schema.marks.code),
  "Mod-z": undo,
  "Mod-Shift-z": redo,
  "Mod-y": redo,
});

// ProseMirror turns a DOM change that looks like a line split into a
// synthesized Enter (meant for iOS). WebKit commits a composition by first
// deleting it and then inserting the result; when the composition is all the
// line holds, that deletion removes the block's whole DOM, which ProseMirror
// reads as Enter: it splits the block and the committed text lands in both.
// No real Enter happens mid-composition, so do what WebKit did instead: empty
// the line (keeping the block), and let the insertion that follows fill it.
const compositionCommit = new Plugin({
  props: {
    handleKeyDown(view, ev) {
      if (ev.isTrusted || ev.keyCode !== 13 || !view.composing) return false;
      const { $head } = view.state.selection;
      if ($head.parent.isTextblock && $head.parent.content.size) view.dispatch(view.state.tr.delete($head.start(), $head.end()));
      return true;
    },
  },
});

// Web pages open in the system browser (Neutralino) or a new tab.
export function openExternal(url) {
  if (inNeutralino) Neutralino.os.open(url);
  else window.open(url, "_blank", "noopener");
}

// Navigation out of an editor (clicking a link or a block reference).
export const hooks = { openPage: (_id) => {}, openBlock: (_id) => {} };

const insertInline = (view, node) =>
  view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
const insertText = (view, text) => { if (text) view.dispatch(view.state.tr.insertText(text)); };

// match quality: prefix < substring; null = no match
function rank(title, q) {
  const t = title.toLowerCase(), k = q.trim().toLowerCase();
  if (!k) return 1;
  if (t === k) return 0;
  if (t.startsWith(k)) return 1;
  return t.includes(k) ? 2 : null;
}

// [[ or #: pick a page or create one. Cancelling leaves the typed text.
function startLink(view, tag, initial = "") {
  openPicker(view, {
    placeholder: tag ? t("picker.tag") : t("picker.page"),
    initial,
    search(q) {
      const pages = [
        ...namedPages().map((p) => ({ value: p.id, label: p.title, sub: t("picker.kindPage") })),
        ...[...pageDates()].map((d) => ({ value: d, label: titleOf(d), sub: t("picker.kindJournal") })),
      ];
      const hits = pages
        .map((p) => ({ p, r: rank(p.label, q) }))
        .filter((x) => x.r !== null)
        .sort((a, b) => a.r - b.r || a.p.label.localeCompare(b.p.label))
        .slice(0, 8)
        .map((x) => x.p);
      const title = q.trim();
      if (title && !findPage(title)) hits.push({ value: null, label: t("picker.create", title), sub: t("picker.newPage") });
      if (title && isDate(title) && !hits.some((h) => h.value === title)) hits.unshift({ value: title, label: titleOf(title), sub: t("picker.kindJournal") });
      return hits;
    },
    onPick(item, q) {
      const page = item.value ?? createPage(q);
      insertInline(view, schema.nodes.link.create({ page, tag }));
    },
    // Backspace on the empty menu takes back what opened it ([[ or #)
    onCancel: (q, how) => { if (how !== "backspace") insertText(view, (tag ? "#" : "[[") + q); },
  });
}

// Returns false when the character should be inserted as plain text.
// `rest` is what follows ch in the same input event; menus receive it.
function typed(view, ch, rest = "") {
  const $head = view.state.selection.$head;
  // code is plain text: no formulas, links or tags
  if ($head.parent.type.spec.code || inCode($head)) return false;
  if ((ch === "$" || ch === "`") && wrapSelection(view, ch)) return true;
  if (ch === "`" && closeInlineCode(view)) return true;
  if (!inMath($head)) {
    if (ch === "$") return insertMath(view.state, view.dispatch);
    const before = $head.nodeBefore?.isText ? $head.nodeBefore.text.slice(-1) : "";
    if (ch === "[" && before === "[") {
      view.dispatch(view.state.tr.delete($head.pos - 1, $head.pos));
      startLink(view, false, rest);
      return true;
    }
    if (ch === "#") { startLink(view, true, rest); return true; }
    // right beside a formula or an atom (tag, link, image) the DOM caret may
    // sit inside it (see navGuard), so the browser must not do the inserting
    if (besideSpecial($head)) {
      view.dispatch(view.state.tr.insertText(ch).scrollIntoView());
      return true;
    }
    return false;
  }
  if (!typeInMath(view, ch)) {
    // "\": a selection within one container stays for the command to wrap;
    // any other is cleared first. Then summon the palette at the caret
    const { $from, $to, empty } = view.state.selection;
    if (!empty && !$from.sameParent($to)) view.dispatch(view.state.tr.deleteSelection());
    openPalette(view, rest);
  }
  return true;
}

const inCode = ($p) => $p.marks().some((m) => m.type === schema.marks.code) ||
  ($p.nodeBefore?.marks.some((m) => m.type === schema.marks.code) && $p.nodeAfter?.marks.some((m) => m.type === schema.marks.code));

// $ or ` over a plain-text selection (within one line) turns it into a
// formula (the text read as LaTeX) or inline code, caret after it.
function wrapSelection(view, ch) {
  const { from, to, $from, $to, empty } = view.state.selection;
  if (empty || inMath($from) || $from.parent !== $to.parent || !$from.parent.inlineContent) return false;
  let plain = true;
  view.state.doc.nodesBetween(from, to, (n) => { if (n.isInline && !n.isText) plain = false; });
  if (!plain) return false;
  const text = view.state.doc.textBetween(from, to);
  const node = ch === "$"
    ? T.math.create(null, parseMath(text))
    : schema.text(text, [schema.marks.code.create()]);
  const tr = view.state.tr.replaceWith(from, to, node);
  tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize));
  view.dispatch(tr.setStoredMarks([]).scrollIntoView());
  return true;
}

// `…` closes into inline code: the text since the opening backtick (in the
// same plain run, not empty) becomes code.
function closeInlineCode(view) {
  const { $head, empty } = view.state.selection;
  const run = $head.nodeBefore;
  if (!empty || !run?.isText || run.marks.length) return false;
  const text = run.text; // nodeBefore is already cut at the caret
  const open = text.lastIndexOf("`");
  if (open < 0 || open === text.length - 1) return false;
  const from = $head.pos - (text.length - open);
  const tr = view.state.tr.replaceWith(from, $head.pos, schema.text(text.slice(open + 1), [schema.marks.code.create()]));
  view.dispatch(tr.setStoredMarks([]).scrollIntoView());
  return true;
}

// Copy writes the outline text format (lossless apart from block ids), and
// paste reads it back, so structure, formulas and task states survive.
// Text from inside one line is written as that text alone (it arrives
// wrapped in its block and line), so that it pastes into a line.
function sliceToText(slice) {
  let { content, openStart, openEnd } = slice;
  const wrapper = (n) => (n.type === T.block && n.childCount === 1) || n.type === T.line || n.type === T.codeblock;
  while (openStart > 0 && openEnd > 0 && content.childCount === 1 && wrapper(content.firstChild)) {
    content = content.firstChild.content;
    openStart--; openEnd--;
  }
  const first = content.firstChild;
  if (!first) return "";
  if (first.type === T.block || first.type === T.line || first.type === T.codeblock) return serializeOutline(T.doc.create(null, content));
  if (first.type.spec.group?.includes("mathinline") && !first.isText) return serializeMath(content);
  return serializeInline(content);
}

// Whether the clipboard holds what this editor copied from inside one line
// (text that pastes inline even when it starts like a block, "- …").
// ProseMirror tags its HTML with the slice's depth and the nodes around it.
function copiedFromOneLine(html) {
  if (!html?.includes("data-pm-slice")) return false;
  const el = new DOMParser().parseFromString(html, "text/html").querySelector("[data-pm-slice]");
  return !!el && (el.classList.contains("pm-line") || /"line"/.test(el.dataset.pmSlice));
}

// Pasted or dropped image files: each becomes its own block.
async function insertImages(view, files) {
  const names = await Promise.all(files.map(addImage));
  const blocks = names.map((src) => T.block.create({ id: newId() }, T.line.create(null, T.image.create({ src }))));
  pasteBlocks(view, T.doc.create(null, blocks));
}

// Images load asynchronously (local store, else the server).
function imageView(node) {
  const dom = document.createElement("img");
  dom.className = "pm-image";
  dom.alt = node.attrs.alt;
  dom.draggable = false;
  imageURL(node.attrs.src).then((url) => {
    if (url) dom.src = url;
    else dom.classList.add("missing");
  });
  return { dom, ignoreMutation: () => true };
}

// Insert pasted blocks next to the caret's block (replacing it when it is an
// empty leaf), caret at the end of the last one.
function pasteBlocks(view, doc) {
  let tr = view.state.tr.deleteSelection();
  const $p = tr.selection.$from;
  let d = $p.depth;
  while (d > 0 && $p.node(d).type !== T.block) d--;
  if (d === 0) return false;
  const block = $p.node(d);
  const replace = block.childCount === 1 && block.firstChild.content.size === 0;
  const at = replace ? $p.before(d) : $p.after(d);
  tr = replace ? tr.replaceWith(at, $p.after(d), doc.content) : tr.insert(at, doc.content);
  const end = at + doc.content.size;
  tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

// onUpdate(view, prevState, tr) runs after every transaction.
// plugins: extra plugins that take precedence over the outline keys.
export function createEditor(mount, doc, { onUpdate, plugins = [] } = {}) {
  let state = EditorState.create({
    doc,
    plugins: [compositionCommit, history(), mathKeys, ...plugins, outlineKeys, keymap(baseKeymap), blockIds, blockDrag, navGuard, selectionShape, mathDecorations, scriptStacking, outlineDecorations, notationHint],
  });
  // notes saved while labelled arrows were x-arrow structures: \overset again
  // (saved with the next edit)
  const upgrade = xArrowsToOverset(state);
  if (upgrade) state = state.apply(upgrade.setMeta("addToHistory", false));
  const view = new EditorView(mount, {
    state,
    // no macOS autocorrect / capitalisation bubbles or spell squiggles:
    // notes are full of math, names and half-sentences
    attributes: { spellcheck: "false", autocorrect: "off", autocapitalize: "off", autocomplete: "off" },
    // keep the caret clear of the journal's sticky week strip
    scrollMargin: { top: 70, bottom: 5, left: 5, right: 5 },
    scrollThreshold: { top: 70, bottom: 0, left: 0, right: 0 },
    dispatchTransaction(tr) {
      const prev = view.state;
      view.updateState(prev.apply(tr));
      onUpdate?.(view, prev, tr);
    },
    handleKeyPress(view, ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length !== 1) return false;
      return typed(view, ev.key);
    },
    handleDOMEvents: {
      // fallback for input that bypasses keypress (autocorrect, dictation)
      beforeinput(view, ev) {
        if (ev.inputType !== "insertText" || !ev.data) return false;
        const $h = view.state.selection.$head;
        if (!inMath($h) && !besideSpecial($h) && !/[$#[`]/.test(ev.data)) return false;
        ev.preventDefault();
        const chars = [...ev.data];
        for (let k = 0; k < chars.length; k++) {
          const rest = chars.slice(k + 1).join("");
          if (!typed(view, chars[k], rest)) view.dispatch(view.state.tr.insertText(chars[k]));
          else if (document.querySelector(".palette")) break; // a menu took the rest
        }
        return true;
      },
    },
    handlePaste(view, ev) {
      const images = [...(ev.clipboardData?.files ?? [])].filter(isImageFile);
      if (images.length && !inMath(view.state.selection.$head)) {
        insertImages(view, images);
        return true;
      }
      const text = ev.clipboardData?.getData("text/plain");
      if (!text) return false;
      const { from, to, $head } = view.state.selection;
      if ($head.parent.type === T.codeblock || inCode($head)) {
        const plain = $head.parent.type === T.codeblock ? text.replace(/\r/g, "") : text.replace(/\s*\n\s*/g, " ");
        view.dispatch(view.state.tr.insertText(plain, from, to).scrollIntoView());
        return true;
      }
      if (inMath($head)) {
        view.dispatch(view.state.tr.replaceWith(from, to, parseMath(text.replace(/^\$|\$$/g, ""))).scrollIntoView());
        return true;
      }
      const inline = (s) => {
        view.dispatch(view.state.tr.replaceWith(from, to, Fragment.fromArray(parseInline(s))).scrollIntoView());
        return true;
      };
      // copied from inside a line: it goes in at the caret, spaces and all,
      // even when it starts like a block ("- …")
      if (!/[\r\n]/.test(text) && copiedFromOneLine(ev.clipboardData.getData("text/html"))) return inline(text);
      // blank lines go, except inside a fenced code block
      let inFence = false;
      const lines = text.replace(/\r/g, "").split("\n").filter((l) => {
        if (/^\s*(- (TODO |DOING |DONE )?)?```/.test(l)) inFence = !inFence;
        return inFence || l.trim();
      });
      if (!lines.length) return inline(text.replace(/[\r\n]/g, "")); // only spaces
      if (lines.length === 1 && !/^\s*- /.test(lines[0])) return inline(lines[0]);
      // several lines (or one whole block): outline text; plain lines become blocks
      const outline = lines.every((l) => /^\s*- /.test(l)) ? lines.join("\n") : lines.map((l) => "- " + l.trim()).join("\n");
      return pasteBlocks(view, parseOutline(outline));
    },
    clipboardTextSerializer: sliceToText,
    nodeViews: { image: imageView },
    handleDrop(view, ev) {
      const images = [...(ev.dataTransfer?.files ?? [])].filter(isImageFile);
      if (!images.length) return false;
      ev.preventDefault();
      const at = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
      if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
      insertImages(view, images);
      return true;
    },
    handleClick(_view, _pos, event) {
      const a = event.target.closest?.("a.web-link");
      if (!a || !(event.metaKey || event.ctrlKey)) return false;
      openExternal(a.dataset.href);
      return true;
    },
    handleClickOn(_view, _pos, node) {
      if (node.type === T.link) { hooks.openPage(node.attrs.page); return true; }
      if (node.type === T.ref) { hooks.openBlock(node.attrs.block); return true; }
      return false;
    },
  });
  return view;
}
