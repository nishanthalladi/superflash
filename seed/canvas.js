export const type = { name: 'canvas', title: 'Canvas' };

/**
 * A canvas. There is only one Type, and this is it — a box *is* a canvas, drawn
 * small. Every one of them has the same three parts:
 *
 *   name   the first line of the body, on the title bar
 *   text   everything after that line, editable
 *   inside its own child canvases, laid out where they were put
 *
 * So a note on the screen shows what it would show if you went inside it, and
 * going inside is only a zoom: the same component, bigger.
 *
 * - double-click empty space → a new canvas, ready to be named
 * - double-click a title bar → go inside that one
 * - Escape → out of the text, out of the selection, out of the note
 * - drag a title bar to move, the corner to resize, Cmd+D for a second pin of the
 *   same note, Backspace (or Cmd+Backspace while typing) to remove one
 * - Shift+Enter runs the body as a module and shows what came out
 *
 * The outermost instance holds the camera and the keyboard; the ones inside it
 * are the same code with `depth > 0`, which only changes how much they draw.
 *
 * ponytail: nested canvases stop drawing children at DEEP levels down. Raise it
 * when a real desk needs to see further.
 */

const VIEW_KEY = 'superflash:view:v2';
const NAME = 'Superflash';
const GRID = 8;
const MIN = 64;
const DEEP = 2;
const snap = (v) => Math.round(v / GRID) * GRID;

/** How deep each pin sits. Set by the canvas that mounts it. */
const DEPTH = new Map();

/** The first line of a body is its name. Nothing else names anything. */
function nameOf(body) {
  const line = body.split('\n').find((l) => l.trim()) || '';
  return line.trim();
}

/** Everything after the name line. */
function restOf(body) {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.trim());
  return at < 0 ? '' : lines.slice(at + 1).join('\n');
}

/** Put the name back on the front of what the text area shows. */
function joinBody(body, tail) {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.trim());
  const head = at < 0 ? '' : lines.slice(0, at + 1).join('\n');
  if (head === '') return tail;
  // No trailing newline for an empty text: a write that changes nothing is still
  // a write, and it would land in the undo history.
  return tail === '' ? head : `${head}\n${tail}`;
}

/** Real ESM from a string, so a canvas can be run. No eval. */
async function load(source) {
  const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`;
  return import(/* @vite-ignore */ url);
}

export default function (host) {
  const kernel = host.kernel();
  const depth = DEPTH.get(host.pin.id) || 0;
  const outer = depth === 0;

  const stop = new AbortController();
  const on = (el, name, fn, opts) => el.addEventListener(name, fn, { signal: stop.signal, ...(opts || {}) });

  /** pinId → { box, face } for every child this canvas has mounted. */
  const kids = new Map();
  const cams = new Map();
  const unwatch = [];

  let root;
  let head;
  let bar;
  let text;
  let out;
  let viewport;
  let layer;

  let current = host.pin.note;
  let trail = [current];
  let drag = null;

  // --- the note this canvas is showing --------------------------------------

  const body = () => (kernel.hasNote(current) ? kernel.body(current) : '');

  function rename(noteId, name) {
    const lines = kernel.body(noteId).split('\n');
    const at = lines.findIndex((l) => l.trim());
    if (at < 0) lines.splice(0, lines.length, name);
    else lines[at] = name;
    kernel.patch(noteId, lines.join('\n'));
  }

  function writeText() {
    kernel.patch(current, joinBody(body(), text.value));
  }

  /**
   * A box holds text, or boxes — never both. So the moment one gains a box, its
   * text becomes the first box inside it. Nothing is lost and nothing needs a
   * strip along the top: going inside a note only ever shows you boxes.
   */
  function spill() {
    const tail = restOf(body());
    if (!tail.trim()) return;
    kernel.journal.transact('spill', () => {
      // Empty this note *before* pinning the box that holds its text: the pin is
      // what calls us, and a note with text still in it would call us again.
      const note = kernel.createNote(tail);
      kernel.patch(current, nameOf(body()));
      kernel.pin(note.id, current, 'canvas', { x: GRID * 5, y: GRID * 5, width: 320, height: 180 });
    });
  }

  function drawName() {
    const name = nameOf(body());
    if (head && document.activeElement !== head) head.value = name;
    if (outer) document.title = name || NAME;
  }

  function drawText(force) {
    if (!text || (!force && document.activeElement === text)) return;
    const tail = restOf(body());
    if (text.value === tail) return;
    text.value = tail;
    // Show the start of the text, not wherever the last caret left it.
    text.scrollTop = 0;
  }

  // --- running --------------------------------------------------------------

  function show(value, bad = false) {
    out.replaceChildren();
    out.classList.toggle('bad', bad);
    if (value === undefined) return void (out.textContent = '');
    if (value instanceof Node) return void out.append(value);
    if (value instanceof Error) return void (out.textContent = `${value.name}: ${value.message}`);
    try {
      out.textContent = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      out.textContent = String(value);
    }
  }

  async function run() {
    writeText();
    out.textContent = '…';
    out.classList.remove('bad');
    try {
      const mod = await load(body());
      const value =
        typeof mod.default === 'function' ? await mod.default(host) : 'out' in mod ? mod.out : mod.default;
      show(await value);
    } catch (err) {
      show(err instanceof Error ? err : new Error(String(err)), true);
    }
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
  }

  function saveView() {
    const saved = {};
    for (const [k, v] of cams) saved[k] = { ...v };
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ at: current, trail: [...trail], cams: saved }));
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

  function enter(note) {
    if (!outer || note === current || !kernel.hasNote(note)) return;
    kernel.setFocus(null);
    for (const id of [...kids.keys()]) drop(id);
    current = note;
    const i = trail.indexOf(note);
    if (i >= 0) trail.length = i + 1;
    else trail.push(note);
    drawName();
    // The text belongs to the note you are now in: take it, focused or not.
    drawText(true);
    render();
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

  function place(point) {
    const id = kernel.journal.transact('place', () => {
      const note = kernel.createNote('');
      const pin = kernel.pin(note.id, current, 'canvas', {
        x: snap(point.x - 130),
        y: snap(point.y - 70),
        width: 260,
        height: 140,
      });
      kernel.setFocus(pin.id);
      return pin.id;
    });
    const entry = kids.get(id);
    if (entry) entry.box.querySelector('.canvas-name').focus();
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

  /** Show a note that already exists, or focus the pin that already shows it. */
  function reveal(noteId, type_, size) {
    if (!kernel.hasNote(noteId) || !kernel.types.has(type_)) return null;
    const already = kernel.childPins(current).find((p) => p.note === noteId);
    if (already) {
      kernel.setFocus(already.id);
      return already.id;
    }
    const rect = viewport.getBoundingClientRect();
    const c = cam();
    const point = { x: (rect.width / 2 - c.x) / c.z, y: (rect.height / 2 - c.y) / c.z };
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

  // --- children ------------------------------------------------------------

  function render() {
    const children = kernel.childPins(current);
    const alive = new Set(children.map((p) => p.id));
    for (const id of [...kids.keys()]) if (!alive.has(id)) drop(id);
    for (const pin of children) ensure(pin);
    // Text or boxes, never both.
    root.classList.toggle('holds', children.length > 0);
    paint();
  }

  function ensure(pin) {
    if (kids.has(pin.id)) return;

    const box = document.createElement('div');
    box.className = 'pin';
    box.dataset.pin = pin.id;
    box.dataset.type = pin.type;

    const face = document.createElement('div');
    face.className = 'pin-face';

    const handle = document.createElement('div');
    handle.className = 'pin-resize';

    box.append(face, handle);
    layer.append(box);
    kids.set(pin.id, { box, face });

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
    if (outer) {
      const c = cam();
      layer.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.z})`;
    }
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
    if (!outer) fit();
  }

  /**
   * A nested canvas shows the same layout, shrunk to fit what it holds — so a note
   * on the screen is a small picture of the note you would see inside it.
   */
  function fit() {
    const children = kernel.childPins(current);
    // With nothing inside, the text gets the whole box.
    root.classList.toggle('holds', children.length > 0);
    if (!children.length) {
      layer.style.transform = 'none';
      return;
    }
    const right = Math.max(...children.map((p) => p.x + p.width));
    const bottom = Math.max(...children.map((p) => p.y + p.height));
    const room = viewport.getBoundingClientRect();
    // Nothing is laid out yet on the first pass; the observer below calls back.
    if (!room.width || !room.height) return;
    const scale = Math.min(1, room.width / (right + GRID), room.height / (bottom + GRID));
    layer.style.transform = `scale(${scale})`;
  }

  /**
   * A preview only knows how much room it has once the browser has laid it out,
   * and that is after mount. Re-fit whenever the room changes.
   */
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

  // --- pointer (outermost only) --------------------------------------------

  function wirePointer() {
    on(viewport, 'pointerdown', (e) => {
      const box = e.target.closest ? e.target.closest('.pin') : null;

      if (!box) {
        kernel.setFocus(null);
        drag = { mode: 'pan', from: { x: e.clientX, y: e.clientY } };
        if (viewport.setPointerCapture) viewport.setPointerCapture(e.pointerId);
        return;
      }

      const pinId = box.dataset.pin;
      kernel.setFocus(pinId);

      // The name is a field: clicking it places a caret and nothing else.
      if (e.target.closest('.canvas-name')) return;
      // Grabbing a bar means no caret anywhere, so Delete deletes the box.
      if (!e.target.closest('.canvas-text') && isTextField(document.activeElement)) {
        document.activeElement.blur();
      }

      const grip = e.target.closest('.canvas-bar');
      const handle = e.target.closest('.pin-resize');
      if (!grip && !handle && !e.altKey) return;

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
      if (!drag) return;
      const c = cam();

      if (drag.mode === 'pan') {
        c.x += e.clientX - drag.from.x;
        c.y += e.clientY - drag.from.y;
        drag.from = { x: e.clientX, y: e.clientY };
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
      drag = null;
    };
    on(viewport, 'pointerup', end);
    on(viewport, 'pointercancel', end);

    on(
      viewport,
      'wheel',
      (e) => {
        e.preventDefault();
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
      const box = e.target.closest ? e.target.closest('.pin') : null;
      if (box) {
        // The whole bar is the way in, name field included.
        if (e.target.closest('.canvas-bar')) {
          e.preventDefault();
          enter(kernel.getPin(box.dataset.pin).note);
        }
        return;
      }
      e.preventDefault();
      place(at(e));
    });
  }

  // --- keys (outermost only) -----------------------------------------------

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

      // Cmd+N: a box, wherever you are. On a note that is still only text, this
      // is the way to start putting boxes on it.
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const c = cam();
        place({ x: (rect.width / 2 - c.x) / c.z || 300, y: (rect.height / 2 - c.y) / c.z || 200 });
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

      // Escape steps out one layer at a time: out of the text, out of the
      // selection, out of the note. So Delete has something to delete.
      if (e.key === 'Escape') {
        if (isTextField(document.activeElement)) document.activeElement.blur();
        else if (kernel.focus()) kernel.setFocus(null);
        else leave();
        return;
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        const pin = kernel.focus();
        if (pin && (mod || !isTextField(document.activeElement))) {
          e.preventDefault();
          kernel.unpin(pin);
        }
        return;
      }

      // Rule 4: everything else goes to the focused pin only.
      kernel.routeKey(e);
    });
  }

  // --- the two shapes of the same thing ------------------------------------

  /** Name, text, output: what every canvas shows about itself. */
  function buildSelf(where, big) {
    head = document.createElement('input');
    head.className = big ? 'canvas-head' : 'canvas-name';
    head.spellcheck = false;
    head.placeholder = big ? 'untitled' : 'name';
    head.value = nameOf(body());
    on(head, 'input', () => rename(current, head.value));
    on(head, 'keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      text.focus();
    });

    text = document.createElement('textarea');
    text.className = 'canvas-text';
    text.spellcheck = false;
    text.placeholder = 'type';
    text.value = restOf(body());
    on(text, 'input', writeText);
    on(text, 'keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        text.setRangeText('  ', text.selectionStart, text.selectionEnd, 'end');
        writeText();
        return;
      }
      if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void run();
      }
    });

    out = document.createElement('div');
    out.className = 'canvas-out';

    if (big) {
      where.append(head);
      return;
    }

    bar = document.createElement('div');
    bar.className = 'canvas-bar';

    // Something to grab: the name beside it is a field, and a click there has to
    // place a caret rather than start a drag.
    const pad = document.createElement('div');
    pad.className = 'canvas-drag';
    pad.title = 'drag to move, double-click to go inside';

    bar.append(head, pad);
    where.append(bar);
  }

  return {
    mount(el) {
      root = el;
      root.classList.add(outer ? 'canvas' : 'canvas-nest');
      if (outer) loadView();

      buildSelf(root, outer);

      viewport = document.createElement('div');
      viewport.className = outer ? 'canvas-viewport' : 'canvas-inside';
      layer = document.createElement('div');
      layer.className = 'canvas-layer';
      viewport.append(layer);

      // Name, text, output, children — the same order at every depth. The text
      // has to be on screen: an off-screen one goes stale and writes back rubbish.
      root.append(text, out, viewport);

      unwatch.push(
        kernel.watch((c) => {
          if (c.kind === 'patch' && c.note === current) {
            drawName();
            drawText();
          }
          // A box just gained a box: its text moves into one.
          if (c.kind === 'pin:add' && kernel.hasPin(c.pin) && kernel.getPin(c.pin).parent === current) spill();
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
        wirePointer();
        wireKeys();
      } else {
        watchRoom();
      }

      drawName();
      render();
    },

    focus() {
      if (text) text.focus();
    },

    blur() {
      if (text) {
        text.blur();
        writeText();
      }
    },

    save() {
      if (text) writeText();
    },

    onPatch() {
      drawName();
      drawText();
    },

    unmount() {
      stop.abort();
      for (const off of unwatch) off();
      unwatch.length = 0;
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
    render,
    run,
  };
}

function isTextField(el) {
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true;
}
