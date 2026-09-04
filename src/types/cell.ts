import type { Note } from '../kernel/model';
import type { Host, TypeInstance } from '../kernel/type';
import { loadSource } from '../kernel/modules';

/**
 * The Cell: the unit of work. Body is source, Run compiles it as a real ES
 * module and shows what came out. Two shapes, checked in order:
 *
 *   export default (host) => value     // called, its return is the output
 *   export const out = value           // the output
 *
 * Top-level `await` and dynamic `import` work, because it is a real module.
 *
 * A Cell holds `shell`, so a Cell can rebuild the app it is running inside.
 * That is the point of it, not an oversight.
 */
export function cell(host: Host): TypeInstance {
  let text: HTMLTextAreaElement;
  let out: HTMLElement;
  let status: HTMLElement;

  function show(value: unknown): void {
    out.replaceChildren();
    out.classList.remove('bad');
    if (value === undefined) {
      status.textContent = 'ok';
      return;
    }
    if (value instanceof Error) {
      out.classList.add('bad');
      out.textContent = `${value.name}: ${value.message}`;
      status.textContent = 'threw';
      return;
    }
    if (value instanceof Node) {
      out.append(value);
      status.textContent = 'ok';
      return;
    }
    out.textContent = render(value);
    status.textContent = 'ok';
  }

  async function run(): Promise<void> {
    host.write(text.value);
    status.textContent = 'running…';
    try {
      const mod = await loadSource(text.value);
      const value =
        typeof mod['default'] === 'function'
          ? await (mod['default'] as (h: Host) => unknown)(host)
          : ('out' in mod ? mod['out'] : mod['default']);
      show(await value);
    } catch (err) {
      show(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Cmd+Enter: run, then focus the next Cell down. Order is `y`, not a list. */
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
    mount(box, note: Note) {
      box.classList.add('cell');

      text = document.createElement('textarea');
      text.className = 'cell-source';
      text.spellcheck = false;
      text.value = note.body;
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

      const tools = document.createElement('div');
      tools.className = 'cell-tools';
      const button = document.createElement('button');
      button.textContent = 'run';
      button.title = 'Shift+Enter';
      button.onclick = () => void run();
      status = document.createElement('span');
      status.className = 'cell-status';
      tools.append(button, status);

      out = document.createElement('div');
      out.className = 'cell-out';

      box.append(text, tools, out);
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
      // The body changed underneath us — either another pin of this Note, or
      // something outside the app. Take it, and keep the caret where it was.
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
