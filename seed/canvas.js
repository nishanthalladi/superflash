export const type = {
  name: 'canvas',
  title: 'Canvas',
  icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><rect x="6" y="6" width="4" height="4" rx="0.5"/></svg>',
};

/**
 * A canvas. Boxes on a surface, and nothing else: a canvas never turns into
 * text, and text never turns into a canvas. What a box *shows* is its pin's
 * Type — `canvas` draws its children small, `text` draws its body, `code` draws a
 * file — and any note can be looked at as any of them.
 *
 * Around every child, whatever its Type, the canvas draws the same bar:
 *
 *   name   the first line of the body
 *   grip   drag to move, double-click to go inside
 *
 * Right-click a bar to pick which Type draws that box. Right-click the big title
 * bar to pick how the note you are *inside* is shown — that one is view state,
 * like the camera: the document says what a note holds, not how you last looked.
 *
 * - double-click empty space → a new box (a canvas)
 * - just start typing → words on the paper, where the pointer last was
 * - paste → a new text box holding the clipboard
 * - double-click a bar → go inside; Escape → out of the text, the selection, the note
 * - drag a bar to move, the corner to resize, Cmd+D for a second pin of the same
 *   note, Backspace (or Cmd+Backspace while typing) to remove one
 *
 * The paper itself is drawable. After the name line and one blank line the body
 * is an Excalidraw scene, `{"type":"excalidraw","version":2,"elements":[...]}`,
 * in the same coordinates as the pins, drawn as crisp SVG under the boxes. The
 * toolbar (outermost only; nested canvases use the same tool) is V select,
 * R rectangle, O ellipse, A arrow, L line, P pen, T text, E eraser by default;
 * the keys, and the stroke width (1, 2, 4), are in the `superflash:settings`
 * note, made on first boot, so editing them is editing text. Right-click the
 * paper or the + opens the palette: search, Enter, arrows. One gesture
 * is one write and one undo step. Ink stroke only, no fill.
 *
 * A canvas inside a canvas is the same code with `depth > 0`: it has its own
 * camera, and while the pointer is over it you are in that world — wheel, drag,
 * double-click all land there and go no further out. Only the outermost holds
 * the keyboard and remembers where you were.
 */

const VIEW_KEY = 'superflash:view:v2';
const NAME = 'Superflash';
const GRID = 8;
const MIN = 64;
const snap = (v) => Math.round(v / GRID) * GRID;

/** How deep each pin sits. Set by the canvas that mounts it. */
const DEPTH = new Map();

/** Line one is the name. Nothing else names anything. */
const nameOf = (body) => body.split('\n')[0] || '';

// --- ink: the paper is an Excalidraw scene ----------------------------------

const NS = 'http://www.w3.org/2000/svg';
/** Crisp 16px single-colour icons: stroke 1.5, currentColor. */
const ico = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const DOT = ico('<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>');
const ICONS = {
  inside: ico('<path d="M2 8 H9 M6.5 5 L9.5 8 L6.5 11 M11 3 H14 V13 H11"/>'),
  duplicate: ico('<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M2.5 10.5 V3.5 A1 1 0 0 1 3.5 2.5 H10.5"/>'),
  delete: ico('<path d="M4 4 L12 12 M12 4 L4 12"/>'),
  keys: ico('<rect x="1.5" y="4.5" width="13" height="7" rx="1.5"/><path d="M4 7 H4.5 M7 7 H7.5 M10 7 H10.5 M5 9.5 H11"/>'),
};
const TOOLS = [
  ['select', ico('<path d="M3 2 L13 8 L8.5 9 L11 13.5 L9.5 14.2 L7 9.8 L3.5 13 Z" fill="currentColor" stroke="none"/>')],
  ['rectangle', ico('<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/>')],
  ['ellipse', ico('<ellipse cx="8" cy="8" rx="5.5" ry="4.5"/>')],
  ['arrow', ico('<path d="M3 13 L13 3 M7 3 H13 V9"/>')],
  ['line', ico('<path d="M3 13 L13 3"/>')],
  ['pen', ico('<path d="M3 13 L4 10 L11 3 L13 5 L6 12 Z"/>')],
  ['text', ico('<path d="M4 3.5 H12 M8 3.5 V13 M6 13 H10"/>')],
  ['eraser', ico('<path d="M6 13 L2.5 9.5 L9 3 L13.5 7.5 L8 13 Z M6 13 H13.5"/>')],
];
/** One tool for every canvas on screen; nested canvases draw with it too. */
let TOOL = 'select';
/** The selected ink element, whichever canvas it is on: `{ del(), clear() }`. */
let SEL = null;

function setTool(name) {
  TOOL = name;
  document.body.dataset.tool = name;
  for (const b of document.querySelectorAll('.canvas-tools button')) b.classList.toggle('on', b.dataset.tool === name);
}

// --- settings: a note in the document, so an agent can rebind by editing text ---

const SETTINGS = 'superflash:settings';
const DEFAULT_KEYS = { palette: 'cmd+shift+d', select: 'v', rectangle: 'r', ellipse: 'o', arrow: 'a', line: 'l', pen: 'p', text: 't', eraser: 'e' };
const STROKES = [1, 2, 4];
/** Shared by every canvas on screen, like TOOL. */
let KEYS = { ...DEFAULT_KEYS };
let STROKE = 2;

const settingsBody = (s) => `Settings\n\n${JSON.stringify(s)}`;

/** The JSON after the name, or `{}` when it does not parse. */
function settings(kernel) {
  try {
    const b = kernel.hasNote(SETTINGS) ? kernel.body(SETTINGS) : '';
    const s = JSON.parse(b.slice(b.indexOf('\n\n') + 2));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function readSettings(kernel) {
  const s = settings(kernel);
  KEYS = { ...DEFAULT_KEYS, ...(s.keys && typeof s.keys === 'object' ? s.keys : {}) };
  STROKE = STROKES.includes(s.stroke) ? s.stroke : 2;
  for (const b of document.querySelectorAll('.canvas-stroke button')) b.classList.toggle('on', Number(b.dataset.w) === STROKE);
}

function setStroke(kernel, w) {
  STROKE = w;
  for (const b of document.querySelectorAll('.canvas-stroke button')) b.classList.toggle('on', Number(b.dataset.w) === w);
  if (kernel.hasNote(SETTINGS)) kernel.journal.transact('settings', () => kernel.patch(SETTINGS, settingsBody({ ...settings(kernel), stroke: w })));
}

/**
 * `r`, `shift+r`, `cmd+shift+t`, `ctrl+alt+x`: what a keydown is called in the
 * settings. Modifiers in a fixed order so the same chord always reads the same.
 */
const keyName = (e) =>
  (e.metaKey ? 'cmd+' : '') + (e.ctrlKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') + e.key.toLowerCase();
/** What the menu shows on the right: `R`, `⇧R`, `⌘⇧T`. */
const keyHint = (k) =>
  (k || '').replace('cmd+', '⌘').replace('ctrl+', '⌃').replace('alt+', '⌥').replace('shift+', '⇧').replace(/(.)$/, (c) => c.toUpperCase());
const MODIFIERS = new Set(['meta', 'control', 'alt', 'shift']);

/** Rebind `name` in the settings note. Empty clears it. */
function setKey(kernel, name, key) {
  if (!kernel.hasNote(SETTINGS)) return;
  const s = settings(kernel);
  const keys = { ...(s.keys || {}) };
  // One key, one thing: a chord taken from elsewhere is freed there.
  for (const k of Object.keys(keys)) if (key && keys[k] === key) keys[k] = '';
  keys[name] = key;
  kernel.journal.transact('settings', () => kernel.patch(SETTINGS, settingsBody({ ...s, keys })));
}
/** Plain substring: "cha" finds chat, "rec" finds rectangle. Loose matching kept too much. */
const fuzzy = (q, s) => s.toLowerCase().includes(q);

/** The scene after the name, or null when the body holds none. */
function parseScene(body) {
  try {
    const scene = JSON.parse(body.slice(body.indexOf('\n\n') + 2));
    if (scene && Array.isArray(scene.elements)) return scene.elements;
  } catch {
    // not a scene
  }
  return null;
}
const inkColor = () => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#3b2f22';
const inkId = () => `ink_${Math.random().toString(36).slice(2, 8)}`;

function shape(type, x, y) {
  return {
    id: inkId(), type, x, y, width: 0, height: 0, angle: 0,
    strokeColor: inkColor(), backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: STROKE, strokeStyle: 'solid', roughness: 0, opacity: 100,
    roundness: type === 'rectangle' ? { type: 3 } : null, isDeleted: false,
    ...(type === 'line' || type === 'arrow' ? { points: [[0, 0], [0, 0]], startArrowhead: null, endArrowhead: type === 'arrow' ? 'arrow' : null } : {}),
    ...(type === 'freedraw' ? { points: [[0, 0]], pressures: [], simulatePressure: true } : {}),
    ...(type === 'text' ? { text: '', originalText: '', fontSize: 20, fontFamily: 2, textAlign: 'left', verticalAlign: 'top', lineHeight: 1.25 } : {}),
  };
}

/** Where an element is, whichever way it was dragged. */
function bbox(el) {
  if (el.points) {
    const xs = el.points.map((p) => p[0]);
    const ys = el.points.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x: el.x + x, y: el.y + y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

function svgEl(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/** One SVG node for one element. Crisp: no roughness, whatever the file says. */
function inkNode(el) {
  let n;
  const abs = el.points ? el.points.map(([px, py]) => `${el.x + px},${el.y + py}`) : [];
  switch (el.type) {
    case 'rectangle':
      n = svgEl('rect', { x: el.x, y: el.y, width: el.width, height: el.height, rx: el.roundness ? 8 : 0 });
      break;
    case 'ellipse':
      n = svgEl('ellipse', { cx: el.x + el.width / 2, cy: el.y + el.height / 2, rx: el.width / 2, ry: el.height / 2 });
      break;
    case 'line':
    case 'arrow':
      n = svgEl('polyline', { points: abs.join(' ') });
      if (el.endArrowhead || el.type === 'arrow') n.setAttribute('marker-end', 'url(#canvas-arrowhead)');
      if (el.startArrowhead) n.setAttribute('marker-start', 'url(#canvas-arrowhead)');
      break;
    case 'freedraw':
      n = svgEl('path', { d: abs.map((p, i) => `${i ? 'L' : 'M'}${p.replace(',', ' ')}`).join(' ') });
      break;
    case 'text': {
      n = svgEl('text', { x: el.x, y: el.y, 'font-size': el.fontSize || 20, 'dominant-baseline': 'hanging' });
      (el.text || '').split('\n').forEach((line, i) => {
        const t = svgEl('tspan', { x: el.x, dy: i ? `${el.lineHeight || 1.25}em` : 0 });
        t.textContent = line || ' ';
        n.append(t);
      });
      n.setAttribute('fill', el.strokeColor);
      break;
    }
    default:
      return null;
  }
  n.dataset.id = el.id;
  if (el.type !== 'text') {
    n.setAttribute('stroke', el.strokeColor);
    n.setAttribute('stroke-width', el.strokeWidth || 2);
    n.setAttribute('fill', !el.backgroundColor || el.backgroundColor === 'transparent' ? 'none' : el.backgroundColor);
  }
  if (el.opacity != null && el.opacity !== 100) n.setAttribute('opacity', el.opacity / 100);
  return n;
}

export default function (host) {
  const kernel = host.kernel();
  const depth = DEPTH.get(host.pin.id) || 0;
  const outer = depth === 0;

  const stop = new AbortController();
  const on = (el, name, fn, opts) => el.addEventListener(name, fn, { signal: stop.signal, ...(opts || {}) });

  /** pinId → { box, face, name, type } for every child this canvas has mounted. */
  const kids = new Map();
  const cams = new Map();
  /** noteId → Type name: how each note is shown when you are inside it. */
  const views = new Map();
  const unwatch = [];
  /** The Type filling the screen instead of the viewport, when `views` says so. */
  let full = null;

  let root;
  let head;
  let stage;
  let viewport;
  let layer;

  let current = host.pin.note;
  let trail = [current];
  let drag = null;
  /** The paper's ink: an svg under the pins, its scene group, and the selection ring. */
  let ink;
  let inkScene;
  let inkSel;
  let inkDrawn = null;
  let selected = null;
  /** Where the pointer last was over the paper, so typing knows where to land. */
  let last = null;
  /** Has this camera been moved by hand? Then `fit` keeps its hands off. */
  let touched = false;

  // --- the note this canvas is showing --------------------------------------

  const body = (id = current) => (kernel.hasNote(id) ? kernel.body(id) : '');

  function rename(noteId, name) {
    const lines = kernel.body(noteId).split('\n');
    lines[0] = name;
    kernel.patch(noteId, lines.join('\n'));
  }

  function drawName() {
    if (head && document.activeElement !== head) head.value = nameOf(body());
    if (outer) document.title = nameOf(body()) || NAME;
  }

  /** The bar of a child: name and type, from the document. */
  function drawBar(pin) {
    const entry = kids.get(pin.id);
    if (!entry) return;
    if (document.activeElement !== entry.name) entry.name.value = nameOf(body(pin.note));
  }

  // --- where you are (outermost only) --------------------------------------

  function loadView() {
    let view = null;
    try {
      view = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
    } catch {
      view = null;
    }
    if (!view || typeof view.at !== 'string') return;
    if (kernel.hasNote(view.at)) current = view.at;
    trail = (view.trail || []).filter((n) => kernel.hasNote(n));
    if (trail[trail.length - 1] !== current) trail = [current];
    for (const [note, cam] of Object.entries(view.cams || {})) cams.set(note, { ...cam });
    for (const [note, as] of Object.entries(view.views || {})) views.set(note, as);
  }

  function saveView() {
    if (!outer) return;
    const saved = {};
    for (const [k, v] of cams) saved[k] = { ...v };
    try {
      localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({ at: current, trail: [...trail], cams: saved, views: Object.fromEntries(views) }),
      );
    } catch {
      // Private mode, quota — the camera is not worth an error.
    }
  }

  function cam() {
    let c = cams.get(current);
    if (!c) {
      c = { x: 0, y: 0, z: 1 };
      cams.set(current, c);
    }
    return c;
  }

  function at(e) {
    const rect = viewport.getBoundingClientRect();
    const c = cam();
    return { x: (e.clientX - rect.left - c.x) / c.z, y: (e.clientY - rect.top - c.y) / c.z };
  }

  function centre() {
    const rect = viewport.getBoundingClientRect();
    const c = cam();
    return { x: (rect.width / 2 - c.x) / c.z || 300, y: (rect.height / 2 - c.y) / c.z || 200 };
  }

  function enter(note) {
    if (!outer) {
      // Only the outermost canvas navigates; ask the one above.
      const above = viewport.parentElement && viewport.parentElement.closest('.canvas-viewport, .canvas-inside');
      const pinEl = above && above.closest('.pin');
      const owner = pinEl ? kernel.instance(pinEl.dataset.pin) : kernel.instance(kernel.childPins(kernel.root)[0]?.id);
      if (owner && owner.enter) owner.enter(note);
      return;
    }
    if (note === current || !kernel.hasNote(note)) return;
    kernel.setFocus(null);
    for (const id of [...kids.keys()]) drop(id);
    select(null);
    inkDrawn = null;
    last = null;
    current = note;
    const i = trail.indexOf(note);
    if (i >= 0) trail.length = i + 1;
    else trail.push(note);
    drawName();
    show();
    saveView();
  }

  function leave() {
    if (trail.length < 2) return;
    const parent = trail[trail.length - 2];
    trail.pop();
    trail.pop();
    enter(parent);
  }

  // --- making things -------------------------------------------------------

  /** A new note at `point`, drawn as `type_`. A new canvas takes the caret in its name. */
  function place(point, type_ = 'canvas', text = '') {
    const id = kernel.journal.transact('place', () => {
      const note = kernel.createNote(text);
      const pin = kernel.pin(note.id, current, type_, {
        x: snap(point.x - 130),
        y: snap(point.y - 70),
        width: 260,
        height: 140,
      });
      kernel.setFocus(pin.id);
      return pin.id;
    });
    if (type_ === 'canvas') kids.get(id)?.name.focus();
    return id;
  }

  function duplicate(pinId) {
    if (!kernel.hasPin(pinId)) return null;
    const pin = kernel.getPin(pinId);
    const copy = kernel.journal.transact('duplicate', () =>
      kernel.pin(pin.note, pin.parent, pin.type, {
        x: pin.x + GRID * 3,
        y: pin.y + GRID * 3,
        width: pin.width,
        height: pin.height,
      }),
    );
    kernel.setFocus(copy.id);
    return copy.id;
  }

  /**
   * Look at the same note through a different Type. A pin's Type is fixed at
   * birth, so this is a new pin in the old one's place — one undo step.
   */
  function retype(pinId, type_) {
    if (!kernel.hasPin(pinId) || !kernel.types.has(type_)) return null;
    const pin = kernel.getPin(pinId);
    if (pin.type === type_) return pinId;
    const made = kernel.journal.transact('retype', () => {
      const { note, parent, x, y, width, height } = pin;
      kernel.unpin(pinId);
      return kernel.pin(note, parent, type_, { x, y, width, height });
    });
    kernel.setFocus(made.id);
    return made.id;
  }

  /** Show a note that already exists, or focus the pin that already shows it. */
  function reveal(noteId, type_, size) {
    if (!kernel.hasNote(noteId) || !kernel.types.has(type_)) return null;
    const already = kernel.childPins(current).find((p) => p.note === noteId);
    if (already) {
      kernel.setFocus(already.id);
      return already.id;
    }
    const point = centre();
    return kernel.journal.transact('reveal', () => {
      const pin = kernel.pin(noteId, current, type_, {
        x: snap(point.x - size[0] / 2),
        y: snap(point.y - size[1] / 2),
        width: size[0],
        height: size[1],
      });
      kernel.setFocus(pin.id);
      return pin.id;
    });
  }

  // --- ink -------------------------------------------------------------------

  const elements = () => parseScene(body()) || [];

  /** One write per gesture: the whole scene, one undo step. */
  function writeInk(els) {
    const name = nameOf(body());
    const rest = els.length ? `\n\n${JSON.stringify({ type: 'excalidraw', version: 2, elements: els })}` : '';
    kernel.journal.transact('ink', () => kernel.patch(current, `${name}${rest}`));
  }

  function drawInk() {
    if (!ink) return;
    const rest = body().slice(nameOf(body()).length);
    if (rest === inkDrawn) return;
    inkDrawn = rest;
    inkScene.replaceChildren(...elements().filter((el) => !el.isDeleted).map(inkNode).filter(Boolean));
    if (selected && !elements().some((el) => el.id === selected)) select(null);
    drawSel();
  }

  function drawSel() {
    const el = selected && elements().find((e) => e.id === selected);
    inkSel.setAttribute('visibility', el ? 'visible' : 'hidden');
    if (!el) return;
    const b = bbox(el);
    for (const [k, v] of Object.entries({ x: b.x - 4, y: b.y - 4, width: b.width + 8, height: b.height + 8 })) inkSel.setAttribute(k, v);
  }

  function select(id) {
    selected = id;
    if (SEL && SEL.owner === ink) SEL = null;
    if (id) SEL = { owner: ink, del: () => writeInk(elements().filter((el) => el.id !== id)), clear: () => select(null) };
    drawSel();
  }

  /** The ink element under the pointer, when the tool can touch ink. */
  const inkAt = (e) => {
    const n = e.target.closest ? e.target.closest('[data-id]') : null;
    return n && inkScene.contains(n) ? elements().find((el) => el.id === n.dataset.id) : null;
  };

  /**
   * Write on the paper: a small textarea over the element while typing, the
   * element itself once you stop (Enter, Escape or a click elsewhere).
   */
  function editText(el, fresh, seed = '') {
    const els = elements();
    const node = inkScene.querySelector(`[data-id="${el.id}"]`);
    if (node) node.style.visibility = 'hidden';
    const area = document.createElement('textarea');
    area.className = 'canvas-ink-edit';
    area.style.left = `${el.x}px`;
    area.style.top = `${el.y}px`;
    area.style.fontSize = `${el.fontSize}px`;
    area.value = fresh ? seed : el.text;
    const size = () => {
      const lines = area.value.split('\n');
      area.rows = lines.length;
      area.cols = Math.max(2, ...lines.map((l) => l.length + 1));
    };
    size();
    area.addEventListener('input', size);
    area.addEventListener('pointerdown', (e) => e.stopPropagation());
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        area.blur();
      }
    });
    area.addEventListener('blur', () => {
      area.remove();
      if (node) node.style.visibility = '';
      const text = area.value.replace(/\n+$/, '');
      if (text === el.text) return;
      const lines = text.split('\n');
      const next = { ...el, text, originalText: text, width: Math.max(...lines.map((l) => l.length)) * el.fontSize * 0.5, height: lines.length * el.fontSize * 1.25 };
      const kept = els.filter((x) => x.id !== el.id);
      writeInk(text ? [...kept, next] : kept);
    });
    layer.append(area);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function startText(point, seed = '') {
    editText(shape('text', point.x, point.y), true, seed);
  }

  /** Follow the pointer while a shape is being dragged out or moved. */
  function inkMove(e) {
    const { el, node, start, points } = drag;
    const p = at(e);
    let dx = p.x - start.x;
    let dy = p.y - start.y;
    if (drag.mode === 'ink-move') {
      drag.moved = { ...el, x: drag.origin.x + dx, y: drag.origin.y + dy };
      node.replaceWith((drag.node = inkNode(drag.moved)));
      return;
    }
    if (el.type === 'freedraw') points.push([dx, dy]);
    else if (el.points) el.points = [[0, 0], [dx, dy]];
    else {
      if (e.shiftKey) {
        const s = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx) * s;
        dy = Math.sign(dy) * s;
      }
      el.x = Math.min(start.x, start.x + dx);
      el.y = Math.min(start.y, start.y + dy);
      el.width = Math.abs(dx);
      el.height = Math.abs(dy);
    }
    node.replaceWith((drag.node = inkNode(el)));
  }

  function inkEnd() {
    const { el, node } = drag;
    if (drag.mode === 'ink-move') {
      if (drag.moved) writeInk(elements().map((x) => (x.id === el.id ? drag.moved : x)));
      return;
    }
    node.remove();
    const b = bbox(el);
    if (b.width < 2 && b.height < 2) return;
    if (el.points) Object.assign(el, { width: b.width, height: b.height });
    writeInk([...elements(), el]);
  }

  // --- children ------------------------------------------------------------

  function render() {
    const children = kernel.childPins(current);
    const alive = new Set(children.map((p) => p.id));
    for (const id of [...kids.keys()]) if (!alive.has(id)) drop(id);
    for (const pin of children) ensure(pin);
    drawInk();
    paint();
  }

  /** The bar every child gets: name, Type, grip. */
  function bar(pin) {
    const el = document.createElement('div');
    el.className = 'canvas-bar';

    const name = document.createElement('input');
    name.className = 'canvas-name';
    name.spellcheck = false;
    name.placeholder = 'name';
    const path = pin.note.startsWith('file:') ? pin.note.slice('file:'.length) : null;
    if (path) {
      name.value = path;
      name.disabled = true;
    } else {
      name.value = nameOf(body(pin.note));
      on(name, 'input', () => rename(pin.note, name.value));
      on(name, 'keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        kernel.instance(pin.id)?.focus?.();
      });
    }

    const grip = document.createElement('div');
    grip.className = 'canvas-drag';
    grip.title = 'drag to move, double-click to go inside, right-click to change what draws it';

    el.append(name, grip);
    return { el, name };
  }

  // --- how a note is shown ---------------------------------------------------

  /** Every way of looking at a note. Tools that ignore their note are left out. */
  const lenses = () => kernel.types.list().filter((t) => t.lens !== false);

  /**
   * The one menu. `items` is a list of `{ label, on, icon?, key?, chosen?, group? }`;
   * a new `group` starts a section. With `search`, a field on top filters the
   * list as you type (characters in order); Enter runs the highlighted row,
   * arrows move it. Anything outside closes it and does nothing else.
   */
  function menu(x, y, items, search = false) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'canvas-menu';
    el.style.left = `${Math.max(0, Math.min(x, innerWidth - 240))}px`;
    el.style.top = `${Math.max(0, Math.min(y, innerHeight - 28 * items.length - 60))}px`;
    let field;
    if (search) {
      field = document.createElement('input');
      field.className = 'canvas-menu-search';
      field.placeholder = 'search…';
      field.spellcheck = false;
      el.append(field);
    }
    const heads = [];
    const rows = [];
    let group;
    for (const item of items) {
      if (item.group && item.group !== group) {
        group = item.group;
        const h = document.createElement('div');
        h.className = 'canvas-menu-group';
        h.textContent = group;
        h.dataset.group = group;
        el.append(h);
        heads.push(h);
      }
      const b = document.createElement('button');
      b.innerHTML = item.icon || DOT;
      const label = document.createElement('span');
      label.textContent = item.label;
      b.append(label);
      b.dataset.group = item.group || '';
      if (item.bind) {
        // The shortcut is a button of its own: click it, press the new chord.
        const hint = document.createElement('kbd');
        hint.className = 'canvas-menu-key';
        // Drawn from `data-key` by CSS, so the row's text stays just its label.
        const show = (k) => (hint.dataset.key = keyHint(k) || '·');
        show(item.key);
        hint.title = 'click to change the shortcut';
        hint.onclick = (e) => {
          e.stopPropagation();
          hint.dataset.key = 'press…';
          hint.classList.add('recording');
          const done = (ev) => {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            if (MODIFIERS.has(ev.key.toLowerCase())) return; // wait for the real key
            window.removeEventListener('keydown', done, { capture: true });
            hint.classList.remove('recording');
            if (ev.key === 'Escape') return show(item.key);
            const chord = ev.key === 'Backspace' ? '' : keyName(ev);
            setKey(kernel, item.bind, chord);
            show(chord);
          };
          window.addEventListener('keydown', done, { capture: true });
        };
        b.append(hint);
      }
      b.classList.toggle('chosen', !!item.chosen);
      b.onclick = () => {
        closeMenu();
        item.on();
      };
      el.append(b);
      rows.push(b);
    }
    document.body.append(el);
    let hi = 0;
    const shown = () => rows.filter((b) => !b.hidden);
    const light = () => shown().forEach((b, i) => b.classList.toggle('hi', search && i === hi));
    if (field) {
      field.oninput = () => {
        const q = field.value.trim().toLowerCase();
        for (const b of rows) b.hidden = !fuzzy(q, b.textContent);
        for (const h of heads) h.hidden = !rows.some((b) => !b.hidden && b.dataset.group === h.dataset.group);
        hi = 0;
        light();
      };
      field.onkeydown = (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const n = shown().length;
          hi = (hi + (e.key === 'ArrowDown' ? 1 : n - 1)) % (n || 1);
          light();
        } else if (e.key === 'Enter') shown()[hi]?.click();
        else return;
        e.preventDefault();
        e.stopPropagation();
      };
      light();
      field.focus();
    }
    // Anything outside the menu closes it, without doing what was clicked.
    const away = (e) => {
      if (!el.isConnected) return el.close();
      if (el.contains(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      closeMenu();
    };
    const esc = (e) => {
      if (e.key !== 'Escape') return;
      // Ours alone: closing the palette must not also step out of the note.
      e.stopImmediatePropagation();
      closeMenu();
    };
    window.addEventListener('pointerdown', away, { capture: true, signal: stop.signal });
    window.addEventListener('keydown', esc, { capture: true, signal: stop.signal });
    el.close = () => {
      window.removeEventListener('pointerdown', away, { capture: true });
      window.removeEventListener('keydown', esc, { capture: true });
      el.remove();
    };
  }

  function closeMenu() {
    for (const m of document.querySelectorAll('.canvas-menu')) m.close ? m.close() : m.remove();
  }

  /** "What do you want here?" — draw something, or place a box. Right-click on paper, or the +. */
  function paperMenu(x, y, point) {
    const draw = TOOLS.filter(([name]) => name !== 'select' && name !== 'eraser').map(([name, icon]) => ({
      group: 'draw',
      label: name,
      icon,
      key: KEYS[name],
      bind: name,
      chosen: TOOL === name,
      on: () => setTool(name),
    }));
    const add = lenses().map((t) => ({
      group: 'add',
      label: t.title,
      icon: t.icon,
      key: KEYS[`add:${t.name}`],
      bind: `add:${t.name}`,
      on: () => place(point, t.name, t.name === 'canvas' ? '' : '\n'),
    }));
    const self = { group: 'palette', label: 'this menu', icon: ICONS.keys, key: KEYS.palette, bind: 'palette', on: () => undefined };
    menu(x, y, [...add, ...draw, self], true);
  }

  /** A box's bar: how to look at it, and what to do with it. */
  function boxMenu(x, y, pinId) {
    const pin = kernel.getPin(pinId);
    const look = lenses().map((t) => ({
      group: 'look at as',
      label: t.title,
      icon: t.icon,
      chosen: t.name === pin.type,
      on: () => retype(pinId, t.name),
    }));
    menu(x, y, [
      ...look,
      { group: 'box', label: 'go inside', icon: ICONS.inside, on: () => enter(pin.note) },
      { group: 'box', label: 'duplicate', icon: ICONS.duplicate, on: () => duplicate(pinId) },
      { group: 'box', label: 'delete', icon: ICONS.delete, on: () => kernel.unpin(pinId) },
    ]);
  }

  /**
   * Show `current` as `type_`. `canvas` is the viewport; anything else fills the
   * stage with that Type, reading and writing `current` through this pin's powers.
   */
  function setView(type_) {
    if (!kernel.types.has(type_)) return;
    if (type_ === 'canvas') views.delete(current);
    else views.set(current, type_);
    saveView();
    show();
  }

  function show() {
    const as = views.get(current) || 'canvas';
    if (full) {
      try {
        full.instance.save?.();
        full.instance.unmount?.();
      } catch {
        // a misbehaving Type must not block the switch
      }
      full.off();
      full.el.remove();
      full = null;
    }
    if (as === 'canvas' || !kernel.types.has(as)) {
      viewport.hidden = false;
      render();
      return;
    }
    for (const id of [...kids.keys()]) drop(id);
    viewport.hidden = true;
    const el = document.createElement('div');
    el.className = 'canvas-full';
    el.dataset.type = as;
    stage.append(el);
    // The shell's host, pointed at the note we are inside. Same powers, other note.
    const note = current;
    const h = Object.create(kernel.host(host.pin.id));
    h.pin = { ...host.pin, note };
    h.read = (id) => kernel.body(id);
    h.write = (text) => kernel.patch(note, text);
    let instance;
    try {
      instance = kernel.types.get(as)(h);
      instance.mount(el, kernel.note(note));
    } catch (err) {
      el.classList.add('broken');
      el.textContent = `${as}: ${err && err.message ? err.message : String(err)}`;
      instance = {};
    }
    const off = kernel.watch((c) => {
      if (c.kind === 'patch' && c.note === note) instance.onPatch?.(kernel.note(note));
    });
    full = { el, instance, off };
    instance.focus?.();
  }

  function ensure(pin) {
    if (kids.has(pin.id)) return;

    const box = document.createElement('div');
    box.className = 'pin';
    box.dataset.pin = pin.id;
    box.dataset.type = pin.type;

    const top = bar(pin);
    const face = document.createElement('div');
    face.className = 'pin-face';
    const handle = document.createElement('div');
    handle.className = 'pin-resize';

    box.append(top.el, face, handle);
    layer.append(box);
    kids.set(pin.id, { box, face, name: top.name });

    // A Type that throws must not take the canvas down with it.
    try {
      DEPTH.set(pin.id, depth + 1);
      const instance = kernel.types.get(pin.type)(kernel.host(pin.id));
      kernel.attach(pin.id, instance);
      instance.mount(face, kernel.note(pin.note));
    } catch (err) {
      box.classList.add('broken');
      face.textContent = `${pin.type}: ${err && err.message ? err.message : String(err)}`;
    }
  }

  function drop(pinId) {
    kernel.detach(pinId);
    DEPTH.delete(pinId);
    const entry = kids.get(pinId);
    if (entry) entry.box.remove();
    kids.delete(pinId);
  }

  /** Geometry, camera, focus ring. No remounting. */
  function paint() {
    if (!layer) return;
    const c = cam();
    layer.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.z})`;
    // The paper moves with the boxes. Zoomed out, every other dot drops away
    // (like map gridlines) so the spacing on screen stays between 18 and 36px
    // and the page never packs into a wall.
    let step = GRID * 3 * c.z;
    while (step < 18) step *= 2;
    while (step > 36) step /= 2;
    viewport.style.backgroundPosition = `${c.x}px ${c.y}px`;
    viewport.style.backgroundSize = `${step}px ${step}px`;
    const focused = kernel.focus();
    for (const pin of kernel.childPins(current)) {
      const entry = kids.get(pin.id);
      if (!entry) continue;
      const box = entry.box;
      box.style.left = `${pin.x}px`;
      box.style.top = `${pin.y}px`;
      box.style.width = `${pin.width}px`;
      box.style.height = `${pin.height}px`;
      box.classList.toggle('focused', pin.id === focused);
    }
  }

  /**
   * A nested canvas opens showing everything it holds, shrunk to fit — so a box on
   * the screen is a small picture of the world inside it, until you move its camera.
   */
  function fit() {
    if (touched || cams.has(current)) return;
    const children = kernel.childPins(current);
    const room = viewport.getBoundingClientRect();
    // Nothing is laid out yet on the first pass; the observer below calls back.
    if (!children.length || !room.width || !room.height) return;
    const right = Math.max(...children.map((p) => p.x + p.width));
    const bottom = Math.max(...children.map((p) => p.y + p.height));
    const z = Math.min(1, room.width / (right + GRID), room.height / (bottom + GRID));
    cams.set(current, { x: 0, y: 0, z });
    paint();
  }

  /** The room is only known after layout, and it changes when the box is resized. */
  function watchRoom() {
    if (typeof ResizeObserver !== 'function') return;
    const eye = new ResizeObserver(() => fit());
    eye.observe(viewport);
    stop.signal.addEventListener('abort', () => eye.disconnect());
  }

  /** A Type was redefined: rebuild what it draws. */
  function remountType(name) {
    for (const pin of kernel.pinsOfType(name)) if (kids.has(pin.id)) drop(pin.id);
    render();
  }

  // --- pointer ---------------------------------------------------------------

  /** The box under the pointer, if it is one of ours — not the box *we* sit in. */
  function boxAt(e) {
    const box = e.target.closest ? e.target.closest('.pin') : null;
    return box && layer.contains(box) ? box : null;
  }

  /** Everything that lands on this viewport is ours: the canvas around us must not also act. */
  function wirePointer() {
    on(viewport, 'pointerdown', (e) => {
      e.stopPropagation();
      const box = boxAt(e);

      if (!box) {
        // Bare paper: out here that clears the selection; in a box, it selects the box.
        kernel.setFocus(outer ? null : host.pin.id);
        if (isTextField(document.activeElement)) document.activeElement.blur();
        if (viewport.setPointerCapture) viewport.setPointerCapture(e.pointerId);
        const hit = inkAt(e);
        const p = at(e);
        if (TOOL === 'eraser') {
          if (hit) writeInk(elements().filter((el) => el.id !== hit.id));
          drag = { mode: 'none' };
        } else if (TOOL === 'select') {
          select(hit ? hit.id : null);
          if (hit) {
            const node = inkScene.querySelector(`[data-id="${hit.id}"]`);
            drag = { mode: 'ink-move', el: hit, node, start: p, origin: { x: hit.x, y: hit.y } };
          } else drag = { mode: 'pan', from: { x: e.clientX, y: e.clientY } };
        } else if (TOOL === 'text') {
          if (hit && hit.type === 'text') editText(hit, false);
          else startText(p);
          drag = { mode: 'none' };
        } else {
          const el = shape(TOOL === 'pen' ? 'freedraw' : TOOL, p.x, p.y);
          const node = inkNode(el);
          ink.append(node);
          drag = { mode: 'ink-draw', el, node, start: p, points: el.points };
        }
        e.preventDefault();
        return;
      }

      const pinId = box.dataset.pin;
      kernel.setFocus(pinId);
      select(null);

      // The name is a field: a click there places a caret and nothing else.
      if (e.target.closest('.canvas-name')) return;
      if (e.button === 2) return;

      const grip = e.target.closest('.canvas-bar');
      const handle = e.target.closest('.pin-resize');
      if (!grip && !handle && !e.altKey) return;

      // Grabbing a bar means no caret anywhere, so Delete deletes the box.
      if (isTextField(document.activeElement)) document.activeElement.blur();

      // Alt+drag makes a second pin of the same note and drags that instead.
      let target = pinId;
      if (e.altKey && !handle) {
        const pin = kernel.getPin(pinId);
        target = kernel.journal.transact('alias', () =>
          kernel.pin(pin.note, pin.parent, pin.type, {
            x: pin.x + GRID * 2,
            y: pin.y + GRID * 2,
            width: pin.width,
            height: pin.height,
          }),
        ).id;
        kernel.setFocus(target);
      }

      const pin = kernel.getPin(target);
      drag = {
        mode: handle ? 'resize' : 'move',
        pin: target,
        from: { x: e.clientX, y: e.clientY },
        start: { x: pin.x, y: pin.y, width: pin.width, height: pin.height },
      };
      if (viewport.setPointerCapture) viewport.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    on(viewport, 'pointermove', (e) => {
      if (!boxAt(e)) last = at(e);
      if (!drag || drag.mode === 'none') return;
      if (drag.mode === 'ink-draw' || drag.mode === 'ink-move') {
        inkMove(e);
        return;
      }
      const c = cam();

      if (drag.mode === 'pan') {
        c.x += e.clientX - drag.from.x;
        c.y += e.clientY - drag.from.y;
        drag.from = { x: e.clientX, y: e.clientY };
        touched = true;
        paint();
        saveView();
        return;
      }

      if (!kernel.hasPin(drag.pin)) {
        drag = null;
        return;
      }
      const dx = (e.clientX - drag.from.x) / c.z;
      const dy = (e.clientY - drag.from.y) / c.z;

      if (drag.mode === 'move') {
        kernel.move(drag.pin, { x: snap(drag.start.x + dx), y: snap(drag.start.y + dy) });
      } else {
        kernel.move(drag.pin, {
          width: Math.max(MIN, snap(drag.start.width + dx)),
          height: Math.max(MIN, snap(drag.start.height + dy)),
        });
      }
    });

    const end = () => {
      if (drag && (drag.mode === 'ink-draw' || drag.mode === 'ink-move')) inkEnd();
      drag = null;
    };
    on(viewport, 'pointerup', end);
    on(viewport, 'pointercancel', end);

    on(
      viewport,
      'wheel',
      (e) => {
        // A wheel over something that scrolls belongs to it, even at the end.
        // Otherwise the nearest canvas takes it, and nothing further out does.
        if (boxAt(e) && scrollable(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        touched = true;
        const c = cam();
        const rect = viewport.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const next = Math.min(4, Math.max(0.1, c.z * Math.exp(-e.deltaY * 0.0015)));
        // keep the point under the cursor fixed
        c.x = px - ((px - c.x) * next) / c.z;
        c.y = py - ((py - c.y) * next) / c.z;
        c.z = next;
        paint();
        saveView();
      },
      { passive: false },
    );

    on(viewport, 'dblclick', (e) => {
      e.stopPropagation();
      const box = boxAt(e);
      if (box) {
        // The whole bar is the way in, name field included.
        if (e.target.closest('.canvas-bar')) {
          e.preventDefault();
          enter(kernel.getPin(box.dataset.pin).note);
        }
        return;
      }
      e.preventDefault();
      const hit = inkAt(e);
      if (hit) {
        if (hit.type === 'text') editText(hit, false);
        return;
      }
      place(at(e));
    });

    // Right-click: on a bar, the box's menu; on bare paper, "what do you want
    // here?"; inside a Type's own face, the browser's menu (a terminal wants its paste).
    on(viewport, 'contextmenu', (e) => {
      const box = boxAt(e);
      if (box) {
        if (!e.target.closest('.canvas-bar')) return;
        e.preventDefault();
        e.stopPropagation();
        boxMenu(e.clientX, e.clientY, box.dataset.pin);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      paperMenu(e.clientX, e.clientY, at(e));
    });
    if (!outer) return;
    on(head, 'contextmenu', (e) => {
      e.preventDefault();
      menu(
        e.clientX,
        e.clientY,
        lenses().map((t) => ({
          group: 'look at as',
          label: t.title,
          icon: t.icon,
          chosen: (views.get(current) || 'canvas') === t.name,
          on: () => setView(t.name),
        })),
      );
    });

    // Paste onto the surface: a text box holding the clipboard, or an image box for a picture.
    on(window, 'paste', (e) => {
      if (isTextField(document.activeElement)) return;
      const item = e.clipboardData && [...(e.clipboardData.items || [])].find((i) => i.type.startsWith('image/'));
      if (item) {
        e.preventDefault();
        void pasteImage(item.getAsFile(), item.type, host.fs()).then((p) => place(centre(), 'image', `\n${p}`));
        return;
      }
      const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (!text) return;
      e.preventDefault();
      // One http(s) URL is a web box; anything else is text.
      const url = /^https?:\/\/\S+$/.test(text.trim()) && kernel.types.has('web');
      place(centre(), url ? 'web' : 'text', `\n${url ? text.trim() : text}`);
    });
  }

  // --- keys (outermost only) -----------------------------------------------

  /** Run whatever the settings bind to this chord. True if something was. */
  function fire(name, e) {
    const bound = Object.keys(KEYS).find((k) => KEYS[k] && KEYS[k] === name);
    if (!bound) return false;
    e.preventDefault();
    if (bound === 'palette') {
      const r = viewport.getBoundingClientRect();
      paperMenu(r.left + r.width / 2 - 120, r.top + r.height / 2 - 180, last || centre());
    } else if (bound.startsWith('add:')) {
      const t = bound.slice(4);
      if (kernel.types.has(t)) place(last || centre(), t, t === 'canvas' ? '' : '\n');
    } else setTool(bound);
    return true;
  }

  function wireKeys() {
    on(window, 'keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) kernel.journal.redo();
        else kernel.journal.undo();
        render();
        return;
      }

      if (mod && e.key.toLowerCase() === 'd') {
        const pin = kernel.focus();
        if (pin) {
          e.preventDefault();
          duplicate(pin);
        }
        return;
      }

      if (mod && e.key === '0') {
        e.preventDefault();
        cams.set(current, { x: 0, y: 0, z: 1 });
        paint();
        saveView();
        return;
      }

      // A chord with a modifier fires anywhere, even while typing: that is what
      // the modifier is for. Bare letters wait their turn below.
      if ((e.metaKey || e.ctrlKey || e.altKey) && fire(keyName(e), e)) return;

      // Escape steps out one layer at a time: out of the drawing tool, out of the
      // text, out of the selection, out of the note. So Delete has something to delete.
      if (e.key === 'Escape') {
        if (TOOL !== 'select') {
          setTool('select');
          return;
        }
        if (isTextField(document.activeElement)) document.activeElement.blur();
        else if (SEL) SEL.clear();
        else if (kernel.focus()) kernel.setFocus(null);
        else leave();
        return;
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        // Ink first: a selected element goes before a focused pin does.
        if (SEL && !isTextField(document.activeElement)) {
          e.preventDefault();
          SEL.del();
          return;
        }
        const pin = kernel.focus();
        if (pin && (mod || !isTextField(document.activeElement))) {
          e.preventDefault();
          kernel.unpin(pin);
        }
        return;
      }

      // Rule 4: everything else goes to the focused pin, if there is one.
      if (kernel.focus() || isTextField(document.activeElement)) {
        kernel.routeKey(e);
        return;
      }

      if (mod || e.altKey || e.key.length !== 1) return;

      // A letter alone picks a tool, or adds a box, as the settings note says.
      if (fire(keyName(e), e)) return;

      // Nothing has the keyboard and you started typing: that is writing on the
      // paper, where the pointer last was. The key lands in the new element.
      e.preventDefault();
      startText(last || centre(), e.key);
    });
  }

  return {
    mount(el) {
      root = el;
      root.classList.add(outer ? 'canvas' : 'canvas-nest');
      if (outer) {
        loadView();
        // Shortcuts and stroke live in the document, as a note anyone can edit.
        if (!kernel.hasNote(SETTINGS)) {
          const keys = { ...DEFAULT_KEYS, ...Object.fromEntries(lenses().map((t) => [`add:${t.name}`, ''])) };
          kernel.journal.transact('settings', () => kernel.createNote(settingsBody({ keys, stroke: 2 }), SETTINGS));
        }
        readSettings(kernel);
      }

      if (outer) {
        head = document.createElement('input');
        head.className = 'canvas-head';
        head.spellcheck = false;
        head.placeholder = 'untitled';
        head.value = nameOf(body());
        on(head, 'input', () => rename(current, head.value));
        on(head, 'keydown', (e) => {
          if (e.key === 'Enter') head.blur();
        });
        root.append(head);
      }

      stage = document.createElement('div');
      stage.className = 'canvas-stage';
      viewport = document.createElement('div');
      viewport.className = outer ? 'canvas-viewport' : 'canvas-inside';
      layer = document.createElement('div');
      layer.className = 'canvas-layer';
      ink = svgEl('svg', { class: 'canvas-ink', width: 1, height: 1 });
      const marker = svgEl('marker', {
        id: 'canvas-arrowhead', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse',
      });
      marker.append(svgEl('path', { d: 'M1 1 L9 5 L1 9', fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.5 }));
      const defs = svgEl('defs', {});
      defs.append(marker);
      inkScene = svgEl('g', { class: 'canvas-ink-scene' });
      inkSel = svgEl('rect', { class: 'canvas-ink-sel', visibility: 'hidden' });
      ink.append(defs, inkScene, inkSel);
      layer.append(ink);
      viewport.append(layer);
      stage.append(viewport);
      if (outer) {
        const plus = document.createElement('button');
        plus.className = 'canvas-plus';
        plus.textContent = '+';
        plus.title = 'what do you want here?';
        on(plus, 'click', () => {
          const r = plus.getBoundingClientRect();
          paperMenu(r.right + 6, r.top, centre());
          plus.blur();
        });
        stage.append(plus);

        // The tray only shows while a drawing tool is active; the + is how you start.
        const tools = document.createElement('div');
        tools.className = 'canvas-tools';
        for (const [name, icon] of TOOLS) {
          const b = document.createElement('button');
          b.dataset.tool = name;
          b.innerHTML = icon;
          b.title = `${name} (${keyHint(KEYS[name])})`;
          b.classList.toggle('on', name === TOOL);
          on(b, 'click', () => {
            setTool(name);
            b.blur();
          });
          tools.append(b);
        }
        // Stroke width: three dots, the chosen one gold.
        const stroke = document.createElement('div');
        stroke.className = 'canvas-stroke';
        for (const w of STROKES) {
          const b = document.createElement('button');
          b.dataset.w = w;
          b.title = `stroke ${w}`;
          b.append(document.createElement('i'));
          b.classList.toggle('on', w === STROKE);
          on(b, 'click', () => {
            setStroke(kernel, w);
            b.blur();
          });
          stroke.append(b);
        }
        tools.append(stroke);
        stage.append(tools);
        document.body.dataset.tool = TOOL;
      }
      root.append(stage);

      unwatch.push(
        kernel.watch((c) => {
          if (c.kind === 'patch') {
            if (c.note === SETTINGS) readSettings(kernel);
            if (c.note === current) {
              drawName();
              drawInk();
            }
            for (const pin of kernel.childPins(current)) if (pin.note === c.note) drawBar(pin);
            return;
          }
          if (full) return;
          if (c.kind === 'pin:move' || c.kind === 'focus') paint();
          else render();
        }),
      );

      if (outer) {
        unwatch.push(
          kernel.spine.subscribeAll((fact) => {
            const data = fact.data || {};
            if (fact.name === 'open-file' && typeof data.path === 'string') {
              reveal(`file:${data.path}`, 'code', [640, 460]);
            } else if (fact.name === 'defined' && typeof data.name === 'string') {
              remountType(data.name);
            }
          }),
        );
        wireKeys();
      } else {
        watchRoom();
      }
      wirePointer();

      drawName();
      if (outer) show();
      else render();
    },

    focus() {
      if (head) head.focus();
    },

    blur() {
      if (head) head.blur();
    },

    onPatch() {
      drawName();
    },

    unmount() {
      closeMenu();
      if (SEL && SEL.owner === ink) SEL = null;
      stop.abort();
      for (const off of unwatch) off();
      unwatch.length = 0;
      if (full) {
        full.off();
        full.instance.unmount?.();
        full = null;
      }
      for (const id of [...kids.keys()]) drop(id);
      if (root) root.replaceChildren();
    },

    // Read by tests, and by anything in a canvas that wants to drive this one.
    get noteId() {
      return current;
    },
    get depth() {
      return depth;
    },
    enter,
    leave,
    reveal,
    retype,
    setView,
    get viewAs() {
      return views.get(current) || 'canvas';
    },
    render,
  };
}

/** Clipboard image → `media/<yyyy-mm-dd-hhmmss>.<ext>` in the repo; resolves to the path. */
async function pasteImage(file, type, fs) {
  const url = await new Promise((r) => {
    const fr = new FileReader();
    fr.onload = () => r(fr.result);
    fr.readAsDataURL(file);
  });
  const b64 = url.slice(url.indexOf(',') + 1);
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '');
  return (await fs.media(`${stamp}.${type === 'image/jpeg' ? 'jpg' : type.slice(6)}`, type, b64)).path;
}

/** Does anything between `el` and its pin scroll? */
function scrollable(el) {
  for (let n = el; n && !(n.classList && n.classList.contains('pin')); n = n.parentElement) {
    if (n.scrollHeight <= n.clientHeight + 1) continue;
    const { overflowY } = getComputedStyle(n);
    if (overflowY === 'auto' || overflowY === 'scroll') return true;
  }
  return false;
}

function isTextField(el) {
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true;
}
