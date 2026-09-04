import type { Note } from '../kernel/model';
import type { Host, TypeInstance } from '../kernel/type';

/**
 * The Code Type: a Note that is a Type. Edit the source, press Run, and the Note
 * is compiled and registered — every pin of that Type reloads.
 *
 * This is the piece that makes the product editable from inside itself.
 * It needs the `define` grant; without it Run is denied like anything else.
 */
export function code(host: Host): TypeInstance {
  let text: HTMLTextAreaElement;
  let status: HTMLElement;

  function say(message: string, bad = false): void {
    status.textContent = message;
    status.classList.toggle('bad', bad);
  }

  async function run(): Promise<void> {
    host.write(text.value);
    say('compiling…');
    try {
      const info = await host.defineModule();
      say(`registered ${info.name}`);
      // The Desk hears this and remounts every pin of that Type.
      host.emit('defined', { name: info.name });
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    }
  }

  return {
    mount(box, note: Note) {
      box.classList.add('code');

      // A file Note is a file, not a module: writing it is the whole point, and
      // "Run" on a `.ts` file would only ever be a compile error.
      const path = note.id.startsWith('file:') ? note.id.slice('file:'.length) : null;

      text = document.createElement('textarea');
      text.className = 'code-source';
      text.spellcheck = false;
      text.value = note.body;
      text.addEventListener('input', () => host.write(text.value));
      // Tab should indent, not leave the box.
      text.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const at = text.selectionStart;
          text.setRangeText('  ', at, text.selectionEnd, 'end');
          host.write(text.value);
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !path) {
          e.preventDefault();
          void run();
        }
      });

      const tools = document.createElement('div');
      tools.className = 'code-tools';

      status = document.createElement('span');
      status.className = 'code-status';

      if (path) {
        status.textContent = path;
        tools.append(status);
      } else {
        const button = document.createElement('button');
        button.textContent = 'Run';
        button.title = 'Compile this Note into a Type (Cmd+Enter)';
        button.onclick = () => void run();
        tools.append(button, status);
      }
      box.append(text, tools);
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
