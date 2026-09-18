export const type = { name: 'canvas', title: 'Canvas' };

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
 * - just start typing → a new text box, with what you typed in it
 * - paste → a new text box holding the clipboard
 * - double-click a bar → go inside; Escape → out of the text, the selection, the note
 * - drag a bar to move, the corner to resize, Cmd+D for a second pin of the same
 *   note, Backspace (or Cmd+Backspace while typing) to remove one
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

  // --- children ------------------------------------------------------------

  function render() {
    const children = kernel.childPins(current);
    const alive = new Set(children.map((p) => p.id));
    for (const id of [...kids.keys()]) if (!alive.has(id)) drop(id);
    for (const pin of children) ensure(pin);
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

  /** A small list of Types at the pointer. `pick` gets the name; anything else closes it. */
  function menu(x, y, chosen, pick) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'canvas-menu';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    // Tools that ignore their note are not ways of looking at one.
    for (const t of kernel.types.list().filter((t) => t.lens !== false)) {
      const b = document.createElement('button');
      b.textContent = t.title;
      b.classList.toggle('chosen', t.name === chosen);
      b.onclick = () => {
        closeMenu();
        pick(t.name);
      };
      el.append(b);
    }
    document.body.append(el);
    // Anything outside the menu closes it, without doing what was clicked.
    const away = (e) => {
      if (el.contains(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      closeMenu();
    };
    const esc = (e) => e.key === 'Escape' && closeMenu();
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
        drag = { mode: 'pan', from: { x: e.clientX, y: e.clientY } };
        if (viewport.setPointerCapture) viewport.setPointerCapture(e.pointerId);
        return;
      }

      const pinId = box.dataset.pin;
      kernel.setFocus(pinId);

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
      if (!drag) return;
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
      place(at(e));
    });

    // Right-click a bar: what draws this box. Right-click the title: how this note is shown.
    on(viewport, 'contextmenu', (e) => {
      const barEl = boxAt(e) && e.target.closest('.canvas-bar');
      if (!barEl) return;
      e.preventDefault();
      e.stopPropagation();
      const pinId = barEl.closest('.pin').dataset.pin;
      menu(e.clientX, e.clientY, kernel.getPin(pinId).type, (t) => retype(pinId, t));
    });
    if (!outer) return;
    on(head, 'contextmenu', (e) => {
      e.preventDefault();
      menu(e.clientX, e.clientY, views.get(current) || 'canvas', setView);
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
      place(centre(), 'text', `\n${text}`);
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

      // Rule 4: everything else goes to the focused pin, if there is one.
      if (kernel.focus() || isTextField(document.activeElement)) {
        kernel.routeKey(e);
        return;
      }

      // Nothing has the keyboard and you started typing: that is a text box. The
      // key itself lands in it — focus moves before the browser inserts.
      if (!mod && !e.altKey && e.key.length === 1) place(centre(), 'text', '\n');
    });
  }

  return {
    mount(el) {
      root = el;
      root.classList.add(outer ? 'canvas' : 'canvas-nest');
      if (outer) loadView();

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
      viewport.append(layer);
      stage.append(viewport);
      root.append(stage);

      unwatch.push(
        kernel.watch((c) => {
          if (c.kind === 'patch') {
            if (c.note === current) drawName();
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
