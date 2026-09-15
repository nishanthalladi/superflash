import type { Note } from '../kernel/model';
import type { Host, TypeInstance } from '../kernel/type';
import { loadSource } from '../kernel/modules';

/**
 * A box. It holds text, and that is all it is until you run it.
 *
 * `Shift+Enter` runs the body as a real ES module and shows what came out
 * underneath. Two shapes, checked in order:
 *
 *   export default (host) => value     // called, its return is the output
 *   export const out = value           // the output
 *
 * There is nothing to choose when you make one: no Type picker, no armed tool. A
 * box is a note until what you type in it says otherwise. Every box is also a
 * canvas — double-click it to go inside.
 *
 * It holds `shell`, so a box can rebuild the app it is running inside. That is
 * the point of it, not an oversight.
 */
export function box(host: Host): TypeInstance {
  let text: HTMLTextAreaElement;
  let out: HTMLElement;

  function show(value: unknown, bad = false): void {
    out.replaceChildren();
    out.classList.toggle('bad', bad);
    if (value === undefined) {
      out.textContent = '';
      return;
    }
    if (value instanceof Node) {
      out.append(value);
      return;
    }
    out.textContent = value instanceof Error ? `${value.name}: ${value.message}` : render(value);
  }

  async function run(): Promise<void> {
    host.write(text.value);
    out.textContent = '…';
    out.classList.remove('bad');
    try {
      const mod = await loadSource(text.value);
      const value =
        typeof mod['default'] === 'function'
          ? await (mod['default'] as (h: Host) => unknown)(host)
          : 'out' in mod
            ? mod['out']
            : mod['default'];
      show(await value);
    } catch (err) {
      show(err instanceof Error ? err : new Error(String(err)), true);
    }
  }

  /** Cmd+Enter: run, then focus the box below. Order is `y`, not a list. */
  function next(): void {
    const kernel = host.kernel();
    const here = host.pin;
    const below = kernel
      .childPins(here.parent)
      .filter((p) => p.id !== here.id && p.y >= here.y)
      .sort((a, b) => a.y - b.y || a.x - b.x)[0];
    if (below) kernel.setFocus(below.id);
  }

  return {
    mount(el, note: Note) {
      text = document.createElement('textarea');
      text.className = 'box-text';
      text.spellcheck = false;
      text.value = note.body;
      text.placeholder = 'type';
      text.addEventListener('input', () => host.write(text.value));
      text.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          text.setRangeText('  ', text.selectionStart, text.selectionEnd, 'end');
          host.write(text.value);
          return;
        }
        if (e.key !== 'Enter') return;
        if (e.shiftKey) {
          e.preventDefault();
          void run();
        } else if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          void run().then(next);
        }
      });

      out = document.createElement('div');
      out.className = 'box-out';

      el.append(text, out);
    },

    focus() {
      text.focus();
    },

    blur() {
      text.blur();
      host.write(text.value);
    },

    save() {
      host.write(text.value);
    },

    onPatch(note: Note) {
      // The body changed underneath us — another pin of this Note, or something
      // outside the app. Take it, and keep the caret where it was.
      if (text.value === note.body) return;
      const from = text.selectionStart;
      const to = text.selectionEnd;
      text.value = note.body;
      if (document.activeElement === text) {
        text.setSelectionRange(Math.min(from, note.body.length), Math.min(to, note.body.length));
      }
    },
  };
}

/** Output is view state — never stored, so a lossy render is fine. */
function render(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
