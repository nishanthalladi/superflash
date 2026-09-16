export const type = { name: 'canvas', title: 'Canvas' };

/**
 * A blank canvas of boxes. That is the whole thing.
 *
 * - double-click empty space → a new box, ready to type in
 * - double-click a box's title bar → go inside it; every box is itself a canvas.
 *   Inside, that note's own text is still there, full width at the top, and its
 *   boxes are on the canvas below. Going in is a zoom, not a change of subject.
 * - Escape → come back out
 * - drag the title bar to move, the corner to resize, Cmd+D for a second pin of
 *   the same box, Backspace to remove one
 *
 * No toolbar, no breadcrumb, no armed Type. There is nothing to choose: a box is
 * a box until what you put in it says otherwise.
 *
 * It holds `shell`, so it gets the kernel. Every geometry change goes through
 * `kernel.move`, so undo and autosave see all of it.
 */

const VIEW_KEY = 'superflash:view:v2';
const NAME = 'Superflash';
const GRID = 8;
const MIN = 64;
const snap = (v) => Math.round(v / GRID) * GRID;

export default function (host) {
  const kernel = host.kernel();
  const stop = new AbortController();
  const on = (el, name, fn, opts) => el.addEventListener(name, fn, { signal: stop.signal, ...(opts || {}) });

  const boxes = new Map();
  const cams = new Map();
  const unwatch = [];

  let root;
  const head = document.createElement('input');
  const viewport = document.createElement('div');
  const layer = document.createElement('div');

  let current = host.pin.note;
  let trail = [current];
  let drag = null;

  // --- where you are -------------------------------------------------------

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

  /** Screen point → canvas coordinates. */
  function at(e) {
    const rect = viewport.getBoundingClientRect();
    const c = cam();
    return { x: (e.clientX - rect.left - c.x) / c.z, y: (e.clientY - rect.top - c.y) / c.z };
  }

  function middle() {
    const c = cam();
    const rect = viewport.getBoundingClientRect();
    return { x: (rect.width / 2 - c.x) / c.z, y: (rect.height / 2 - c.y) / c.z };
  }

  // --- in and out ----------------------------------------------------------

  function enter(note) {
    if (note === current || !kernel.hasNote(note)) return;
    kernel.setFocus(null);
    for (const id of [...boxes.keys()]) drop(id);
    current = note;
    const i = trail.indexOf(note);
    if (i >= 0) trail.length = i + 1;
    else trail.push(note);
    drawHead();
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

  /** A new, empty box where you clicked, ready to be named. */
  function place(point, type_ = 'box') {
    if (!kernel.types.has(type_)) return null;
    const id = kernel.journal.transact('place', () => {
      const note = kernel.createNote('');
      const pin = kernel.pin(note.id, current, type_, {
        x: snap(point.x - 130),
        y: snap(point.y - 60),
        width: 260,
        height: 120,
      });
      kernel.setFocus(pin.id);
      return pin.id;
    });
    // The name comes first, so that is where the caret goes.
    const grip = boxes.get(id) && boxes.get(id).querySelector('.pin-grip');
    if (grip) grip.focus();
    return id;
  }

  /** Cmd+D: another pin of the same box. One body, two places. */
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

  /** Show a Note that already exists, or focus the pin that already shows it. */
  function reveal(noteId, type_, size) {
    if (!kernel.hasNote(noteId) || !kernel.types.has(type_)) return null;
    const already = kernel.childPins(current).find((p) => p.note === noteId);
    if (already) {
      kernel.setFocus(already.id);
      return already.id;
    }
    const point = middle();
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

  /** The first line of a note's body is its name. Nothing else names anything. */
  function title(noteId) {
    const body = kernel.hasNote(noteId) ? kernel.body(noteId) : '';
    const line = body.split('\n').find((l) => l.trim()) || '';
    return line.trim().slice(0, 60);
  }

  /**
   * The name of the note you are inside, big and centred. It is the first line of
   * the body, not a separate field — editing it rewrites that line and leaves the
   * rest of the text alone.
   */
  function drawHead() {
    if (document.activeElement !== head) head.value = title(current);
    document.title = title(current) || NAME;
  }

  /** Rewrite a note's name line and leave the rest of its text alone. */
  function rename(noteId, name) {
    const lines = kernel.body(noteId).split('\n');
    const at = lines.findIndex((l) => l.trim());
    if (at < 0) lines.splice(0, lines.length, name);
    else lines[at] = name;
    kernel.patch(noteId, lines.join('\n'));
  }

  // --- drawing -------------------------------------------------------------

  function render() {
    const children = kernel.childPins(current);
    const alive = new Set(children.map((p) => p.id));
    for (const id of [...boxes.keys()]) if (!alive.has(id)) drop(id);
    for (const pin of children) ensure(pin);
    paint();
  }

  function ensure(pin) {
    if (boxes.has(pin.id)) return;

    const box = document.createElement('div');
    box.className = 'pin';
    box.dataset.pin = pin.id;
    box.dataset.type = pin.type;

    // The title bar *is* the name: an input on the note's first line. So the name
    // is never on screen twice, and typing it never makes text jump.
    const bar = document.createElement('div');
    bar.className = 'pin-bar';

    const grip = document.createElement('input');
    grip.className = 'pin-grip';
    grip.spellcheck = false;
    grip.placeholder = 'name';
    grip.value = title(pin.note);
    on(grip, 'input', () => rename(pin.note, grip.value));
    on(grip, 'keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const inside = box.querySelector('.pin-face textarea, .pin-face input');
      if (inside) inside.focus();
    });

    // Drag and enter live here, so a click on the name only ever places a caret.
    const drag = document.createElement('div');
    drag.className = 'pin-drag';
    drag.title = 'drag to move, double-click to go inside';

    bar.append(grip, drag);

    const face = document.createElement('div');
    face.className = 'pin-face';

    const handle = document.createElement('div');
    handle.className = 'pin-resize';

    box.append(bar, face, handle);
    layer.append(box);
    boxes.set(pin.id, box);

    // A Type that throws must not take the canvas down with it.
    try {
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
    const box = boxes.get(pinId);
    if (box) box.remove();
    boxes.delete(pinId);
  }

  /** Geometry, camera, focus ring. No remounting. */
  function paint() {
    const c = cam();
    layer.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.z})`;
    const focused = kernel.focus();
    for (const pin of kernel.childPins(current)) {
      const box = boxes.get(pin.id);
      if (!box) continue;
      box.style.left = `${pin.x}px`;
      box.style.top = `${pin.y}px`;
      box.style.width = `${pin.width}px`;
      box.style.height = `${pin.height}px`;
      const grip = box.querySelector('.pin-grip');
      if (grip && document.activeElement !== grip) grip.value = title(pin.note);
      // A box that holds other boxes says so, quietly.
      box.classList.toggle('deep', kernel.childPins(pin.note).length > 0);
      box.classList.toggle('focused', pin.id === focused);
    }
  }

  /** A Type was redefined: rebuild the boxes drawn by it. */
  function remountType(name) {
    for (const pin of kernel.pinsOfType(name)) if (boxes.has(pin.id)) drop(pin.id);
    render();
  }

  // --- pointer -------------------------------------------------------------

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

      // The name field is a field: clicking it places a caret and nothing else.
      if (e.target.closest('.pin-grip')) return;
      // Selecting a box by its bar means no caret anywhere, so Delete deletes it.
      if (!e.target.closest('.pin-face') && isTextField(document.activeElement)) {
        document.activeElement.blur();
      }
      const grip = e.target.closest('.pin-drag') || e.target.closest('.pin-bar');
      const handle = e.target.closest('.pin-resize');
      if (!grip && !handle && !e.altKey) return;

      // Alt+drag makes a second pin of the same box and drags that instead.
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
        // The bar is the way in — but not the name field on it, where a
        // double-click selects a word, as it should.
        if (e.target.closest('.pin-bar') && !e.target.closest('.pin-grip')) {
          e.preventDefault();
          enter(kernel.getPin(box.dataset.pin).note);
        }
        return;
      }
      e.preventDefault();
      place(at(e));
    });
  }

  // --- keys ----------------------------------------------------------------

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

      // Escape steps out one layer at a time: out of the text, then out of the
      // selection, then out of the note. So Delete has something to delete.
      if (e.key === 'Escape') {
        if (isTextField(document.activeElement)) document.activeElement.blur();
        else if (kernel.focus()) kernel.setFocus(null);
        else leave();
        return;
      }

      // Cmd+Backspace removes the box you are in even while the caret is in it.
      // Plain Backspace only removes one when you are not typing.
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

  return {
    mount(box) {
      root = box;
      root.classList.add('canvas');
      loadView();

      head.className = 'canvas-head';
      head.spellcheck = false;
      head.placeholder = 'untitled';
      on(head, 'input', () => rename(current, head.value));

      viewport.className = 'canvas-viewport';
      layer.className = 'canvas-layer';
      viewport.append(layer);
      root.append(head, viewport);

      unwatch.push(
        kernel.watch((c) => {
          if (c.kind === 'patch' && c.note === current) drawHead();
          if (c.kind === 'pin:move' || c.kind === 'focus') paint();
          else render();
        }),
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
      drawHead();
      render();
    },

    unmount() {
      stop.abort();
      for (const off of unwatch) off();
      unwatch.length = 0;
      for (const id of [...boxes.keys()]) drop(id);
      if (root) root.replaceChildren();
    },

    // Read by tests, and by anything in a box that wants to drive the canvas.
    get noteId() {
      return current;
    },
    enter,
    leave,
    reveal,
    render,
  };
}

function isTextField(el) {
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true;
}
