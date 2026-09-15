export const type = { name: 'split', title: 'Split' };

/**
 * Layout, as a Type. A Note whose body is `row` or `col`, and whose child pins
 * are laid out along that axis with a draggable divider between them.
 *
 * This is what replaced `chrome`. Nothing is a privileged layer any more: the
 * sidebar is always visible because it is a pane in a split, not because the
 * kernel knows it is furniture. Splits nest, so the toolbar is a `col` above a
 * `row` of [tree, desk].
 *
 * Sizes are `pin.width` / `pin.height`, so a dragged divider goes through
 * `kernel.move` — which means the layout is in the document, undoable, and
 * saved, with no new field anywhere. `0` means "take what is left".
 */

const MIN = 48;

export default function (host) {
  const kernel = host.kernel();
  const stop = new AbortController();
  const on = (el, name, fn, opts) => el.addEventListener(name, fn, { signal: stop.signal, ...(opts || {}) });

  const mounted = new Map();
  const unwatch = [];
  let root;
  let drag = null;

  const note = () => kernel.note(host.pin.note);
  const column = () => note().body.trim().startsWith('c');

  /** Order is `x` along a row, `y` down a column. */
  const panes = () =>
    kernel.childPins(host.pin.note).sort((a, b) => (column() ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y));

  const sizeOf = (pin) => (column() ? pin.height : pin.width);

  function render() {
    const pins = panes();
    const alive = new Set(pins.map((p) => p.id));
    for (const id of [...mounted.keys()]) if (!alive.has(id)) drop(id);

    root.replaceChildren();
    // Add, never assign: a nested split's box is its parent's `.split-pane`, and
    // assigning would throw that class away.
    root.classList.add('split');
    root.classList.toggle('split-col', column());
    root.classList.toggle('split-row', !column());

    pins.forEach((pin, i) => {
      root.append(pane(pin));
      if (i < pins.length - 1) root.append(divider(pin));
    });
  }

  const mine = (pinId) => kernel.hasPin(pinId) && kernel.getPin(pinId).parent === host.pin.note;

  /** Sizes only. Rebuilding the DOM would blur whatever is focused in a pane. */
  function resize() {
    for (const pin of panes()) {
      const entry = mounted.get(pin.id);
      if (!entry) continue;
      const size = sizeOf(pin);
      entry.box.style.flex = size > 0 ? `0 0 ${size}px` : '1 1 0%';
    }
  }

  function pane(pin) {
    let entry = mounted.get(pin.id);
    if (!entry) {
      const box = document.createElement('div');
      box.className = 'split-pane';
      box.dataset.pin = pin.id;
      box.dataset.type = pin.type;
      const factory = kernel.types.has(pin.type) ? kernel.types.get(pin.type) : null;
      entry = { box, factory };
      mounted.set(pin.id, entry);
      // A Type that throws must not take the layout down with it.
      try {
        const instance = factory(kernel.host(pin.id));
        kernel.attach(pin.id, instance);
        instance.mount(box, kernel.note(pin.note));
      } catch (err) {
        box.classList.add('broken');
        box.textContent = `${pin.type}: ${err && err.message ? err.message : String(err)}`;
      }
    }
    const size = sizeOf(pin);
    // 0 means flexible: one pane usually takes whatever the fixed ones leave.
    entry.box.style.flex = size > 0 ? `0 0 ${size}px` : '1 1 0%';
    return entry.box;
  }

  function divider(before) {
    const bar = document.createElement('div');
    bar.className = 'split-bar';
    on(bar, 'pointerdown', (e) => {
      e.preventDefault();
      drag = { pin: before.id, from: column() ? e.clientY : e.clientX, start: sizeOf(kernel.getPin(before.id)) };
      if (bar.setPointerCapture) bar.setPointerCapture(e.pointerId);
    });
    return bar;
  }

  function drop(pinId) {
    kernel.detach(pinId);
    const entry = mounted.get(pinId);
    if (entry) entry.box.remove();
    mounted.delete(pinId);
  }

  return {
    mount(box) {
      root = box;

      on(window, 'pointermove', (e) => {
        if (!drag) return;
        const at = column() ? e.clientY : e.clientX;
        // A flexible pane has size 0; dragging its divider gives it a real size.
        const start = drag.start > 0 ? drag.start : (column() ? root.clientHeight : root.clientWidth) / 2;
        const next = Math.max(MIN, Math.round(start + at - drag.from));
        kernel.move(drag.pin, column() ? { height: next } : { width: next });
      });
      const end = () => {
        drag = null;
      };
      on(window, 'pointerup', end);
      on(window, 'pointercancel', end);

      unwatch.push(
        kernel.watch((c) => {
          if (c.kind === 'pin:move') {
            if (mine(c.pin)) resize();
          } else if (c.kind === 'pin:add') {
            if (mine(c.pin)) render();
          } else if (c.kind === 'pin:remove') {
            if (c.parent === host.pin.note) render();
          } else if (c.kind === 'patch' && c.note === host.pin.note) {
            render();
          }
        }),
        // A pane's Type was redefined: rebuild that pane, and only that pane.
        kernel.types.watch(() => {
          for (const [id, entry] of [...mounted]) {
            const pin = kernel.hasPin(id) ? kernel.getPin(id) : null;
            const now = pin && kernel.types.has(pin.type) ? kernel.types.get(pin.type) : null;
            if (now !== entry.factory) drop(id);
          }
          render();
        }),
      );

      render();
    },

    /** The body says `row` or `col`; a change to it is a re-layout. */
    onPatch() {
      render();
    },

    unmount() {
      stop.abort();
      for (const off of unwatch) off();
      unwatch.length = 0;
      for (const id of [...mounted.keys()]) drop(id);
      if (root) root.replaceChildren();
    },
  };
}
