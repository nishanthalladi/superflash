export const type = { name: 'desk', title: 'Desk' };

/**
 * The Desk, as a Note. Pan, zoom, click, focus, drag, nest. It owns the DOM and
 * nothing else — and it lives in the document, so you can edit it from a Cell
 * and watch it remount.
 *
 * It holds `shell`, so it gets the kernel. Every geometry change still goes
 * through `kernel.move`, so undo and autosave see all of it.
 */

const VIEW_KEY = 'desk:view:v1';
const GRID = 8;
const MIN = 64;
const snap = (v) => Math.round(v / GRID) * GRID;

const MODULE_TEMPLATE = `export const type = { name: 'my-type', title: 'My Type' };

export default function (host) {
  return {
    mount(box, note) {
      box.textContent = note.body || 'hello from a module';
    },
  };
}
`;

const CELL_TEMPLATE = `// Shift+Enter to run. \`host\` is this pin's Host.
export default (host) => host.pin.note;
`;

export default function (host) {
  const kernel = host.kernel();
  const stop = new AbortController();
  const on = (el, name, fn, opts) =>
    el.addEventListener(name, fn, { signal: stop.signal, ...(opts || {}) });

  const boxes = new Map();
  const cams = new Map();
  const unwatch = [];

  let root;
  const bar = document.createElement('div');
  const viewport = document.createElement('div');
  const layer = document.createElement('div');
  const chromeLayer = document.createElement('div');

  let current = host.pin.note;
  let trail = [current];
  let armed = 'stub';
  let drag = null;

  const chromeNote = () => kernel.chrome;

  // --- view state ----------------------------------------------------------

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
    const cams_ = {};
    for (const [k, v] of cams) cams_[k] = { ...v };
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ at: current, trail: [...trail], cams: cams_ }));
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

  // --- geometry helpers ----------------------------------------------------

  const solo = () => kernel.childPins(current).length === 1;

  /** Screen point → canvas coordinates on the current Note. */
  function at(e) {
    const rect = viewport.getBoundingClientRect();
    const c = cam();
    return { x: (e.clientX - rect.left - c.x) / c.z, y: (e.clientY - rect.top - c.y) / c.z };
  }

  /** Canvas point at the centre of the viewport. */
  function middle() {
    const c = cam();
    const rect = viewport.getBoundingClientRect();
    return { x: (rect.width / 2 - c.x) / c.z, y: (rect.height / 2 - c.y) / c.z };
  }

  // --- navigation ----------------------------------------------------------

  function open(note) {
    if (note === current || !kernel.hasNote(note)) return;
    kernel.setFocus(null);
    for (const id of [...boxes.keys()]) if (!isChromePin(id)) drop(id);
    current = note;
    const i = trail.indexOf(note);
    if (i >= 0) trail.length = i + 1;
    else trail.push(note);
    render();
    saveView();
  }

  function back() {
    if (trail.length < 2) return;
    const parent = trail[trail.length - 2];
    trail.pop();
    trail.pop();
    open(parent);
  }

  function isChromePin(pinId) {
    const chrome = chromeNote();
    return chrome !== null && kernel.hasPin(pinId) && kernel.getPin(pinId).parent === chrome;
  }

  // --- making things -------------------------------------------------------

  /** Double-click on bare canvas: a new Note of the armed Type, centred there. */
  function place(point, wanted = armed) {
    const type_ = kernel.types.has(wanted) ? wanted : 'cell';
    if (!kernel.types.has(type_)) return null;
    const seed = type_ === 'cell' ? CELL_TEMPLATE : '';
    return kernel.journal.transact('place', () => {
      const note = kernel.createNote(seed);
      const pin = kernel.pin(note.id, current, type_, {
        x: snap(point.x - 120),
        y: snap(point.y - 80),
        width: 240,
        height: 160,
      });
      kernel.setFocus(pin.id);
      return pin.id;
    });
  }

  /** Cmd+D: another pin of the same Note. One body, two places. */
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
   * Show a Note that already exists. Used for files: the tree says which one, and
   * the Desk decides where, because the Desk is what knows where you are looking.
   * A second click focuses the pin you already have instead of making another.
   */
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

  /** A new Note of the given Type, seeded with a template, placed and focused. */
  function newNote(type_, body, size) {
    if (!kernel.types.has(type_)) return null;
    const point = middle();
    return kernel.journal.transact(`new-${type_}`, () => {
      const note = kernel.createNote(body);
      const pin = kernel.pin(note.id, current, type_, {
        x: Math.round(point.x - size[0] / 2),
        y: Math.round(point.y - size[1] / 2),
        width: size[0],
        height: size[1],
      });
      kernel.setFocus(pin.id);
      return pin.id;
    });
  }

  // --- render --------------------------------------------------------------

  function render() {
    const children = kernel.childPins(current);
    const chrome = chromeNote();
    const chromePins = chrome ? kernel.childPins(chrome) : [];
    const alive = new Set([...children, ...chromePins].map((p) => p.id));
    for (const id of [...boxes.keys()]) if (!alive.has(id)) drop(id);

    for (const pin of children) ensure(pin, layer);
    for (const pin of chromePins) ensure(pin, chromeLayer);

    paint();
    paintBar();
  }

  function ensure(pin, parent) {
    const existing = boxes.get(pin.id);
    if (existing) {
      if (existing.parentElement !== parent) parent.append(existing);
      return;
    }

    const box = document.createElement('div');
    box.className = parent === chromeLayer ? 'pin pin-fixed' : 'pin';
    box.dataset.pin = pin.id;
    box.dataset.type = pin.type;

    const grip = document.createElement('div');
    grip.className = 'pin-grip';
    grip.textContent = pin.type;

    const face = document.createElement('div');
    face.className = 'pin-face';

    const handle = document.createElement('div');
    handle.className = 'pin-resize';

    box.append(grip, face, handle);
    parent.append(box);
    boxes.set(pin.id, box);

    // A Type that throws must not take the Desk down with it.
    try {
      const instance = kernel.types.get(pin.type)(kernel.host(pin.id));
      kernel.attach(pin.id, instance);
      instance.mount(face, kernel.note(pin.note));
    } catch (err) {
      box.classList.add('broken');
      face.textContent = `${pin.type}: ${err && err.message ? err.message : String(err)}`;
    }
  }

  /** A Type was redefined: throw away its live instances and build them again. */
  function remountType(name) {
    for (const pin of kernel.pinsOfType(name)) if (boxes.has(pin.id)) drop(pin.id);
    render();
  }

  function drop(pinId) {
    kernel.detach(pinId);
    const box = boxes.get(pinId);
    if (box) box.remove();
    boxes.delete(pinId);
  }

  /** Cheap pass: geometry, camera, focus ring. No remounting. */
  function paint() {
    const children = kernel.childPins(current);
    const one = children.length === 1;
    const c = cam();
    layer.style.transform = one ? 'none' : `translate(${c.x}px, ${c.y}px) scale(${c.z})`;
    viewport.classList.toggle('solo', one);

    const chrome = chromeNote();
    const focused = kernel.focus();
    for (const pin of [...children, ...(chrome ? kernel.childPins(chrome) : [])]) {
      const box = boxes.get(pin.id);
      if (!box) continue;
      const full = one && pin.parent === current;
      if (full) {
        box.style.inset = '0';
        box.style.left = box.style.top = box.style.width = box.style.height = '';
      } else {
        box.style.inset = '';
        box.style.left = `${pin.x}px`;
        box.style.top = `${pin.y}px`;
        box.style.width = `${pin.width}px`;
        box.style.height = `${pin.height}px`;
      }
      box.classList.toggle('full', full);
      box.classList.toggle('focused', pin.id === focused);
    }
  }

  function paintBar() {
    bar.replaceChildren();
    trail.forEach((note, i) => {
      const b = document.createElement('button');
      b.textContent = i === 0 ? 'desk' : note.split('_')[1] || note;
      b.onclick = () => open(note);
      bar.append(b);
    });

    const info = document.createElement('span');
    info.className = 'desk-info';
    const count = kernel.childPins(current).length;
    info.textContent = [
      `${count} pin${count === 1 ? '' : 's'}`,
      solo() ? 'full screen' : `${Math.round(cam().z * 100)}%`,
      `armed: ${armed}`,
      `undo ${kernel.journal.depth.past}`,
    ].join(' · ');
    bar.append(info);
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
      if (solo()) return;

      const grip = e.target.closest('.pin-grip');
      const handle = e.target.closest('.pin-resize');
      if (!grip && !handle && !e.altKey) return;

      // Alt+drag makes a second pin of the same Note and drags that instead.
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
        if (solo()) return;
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
      e.preventDefault();
      if (box) open(kernel.getPin(box.dataset.pin).note);
      else place(at(e));
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

      if (e.key === 'Escape') {
        if (kernel.focus()) kernel.setFocus(null);
        else back();
        return;
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        const pin = kernel.focus();
        if (pin && !isTextField(document.activeElement)) {
          e.preventDefault();
          kernel.unpin(pin);
        }
        return;
      }

      // Rule 4: everything else goes to the focused pin only.
      kernel.routeKey(e);
    });
  }

  /** Chrome talks to the Desk over the Spine, so chrome needs no extra grants. */
  function onFact(fact) {
    const data = fact.data || {};
    switch (fact.name) {
      case 'arm':
        if (typeof data.type === 'string' && kernel.types.has(data.type)) {
          armed = data.type;
          paintBar();
        }
        return;
      case 'open':
        if (typeof data.note === 'string') open(data.note);
        return;
      case 'new-module':
        newNote('code', MODULE_TEMPLATE, [360, 280]);
        return;
      case 'new-cell':
        newNote('cell', CELL_TEMPLATE, [420, 260]);
        return;
      case 'open-file':
        if (typeof data.path === 'string') reveal(`file:${data.path}`, 'code', [640, 460]);
        return;
      case 'place':
        if (typeof data.type === 'string') place(middle(), data.type);
        return;
      case 'defined':
        if (typeof data.name === 'string') remountType(data.name);
        return;
      default:
        return;
    }
  }

  return {
    mount(box) {
      root = box;
      root.classList.add('desk');
      loadView();

      bar.className = 'desk-bar';
      viewport.className = 'desk-viewport';
      layer.className = 'desk-layer';
      chromeLayer.className = 'desk-chrome';
      viewport.append(layer, chromeLayer);
      root.append(bar, viewport);

      unwatch.push(
        kernel.watch((c) => {
          if (c.kind === 'pin:move' || c.kind === 'focus') paint();
          else render();
        }),
        kernel.spine.subscribeAll(onFact),
        kernel.types.watch(() => {
          paintBar();
          // Chrome lists the Types, so it has to hear about a new one.
          const chrome = chromeNote();
          if (chrome) for (const pin of kernel.childPins(chrome)) drop(pin.id);
          render();
        }),
      );

      wirePointer();
      wireKeys();
      render();
    },

    unmount() {
      stop.abort();
      for (const off of unwatch) off();
      unwatch.length = 0;
      for (const id of [...boxes.keys()]) drop(id);
      if (root) root.replaceChildren();
    },

    // Read by tests and by Cells.
    get noteId() {
      return current;
    },
    get armed() {
      return armed;
    },
    open,
    render,
  };
}

function isTextField(el) {
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true;
}
