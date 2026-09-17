export const type = { name: 'text', title: 'Text' };

/**
 * Text. The plainest Type there is: everything after the name line, in a
 * textarea. Shift+Enter runs the body as a module and shows what came out, so a
 * text box is also the place you type code to run.
 *
 * The name (line one) is drawn by the canvas this pin sits on, not here — the
 * bar around a box is the same for every Type.
 */

const restOf = (body) => body.split('\n').slice(1).join('\n');
const nameOf = (body) => body.split('\n')[0] || '';
const join = (name, rest) => (rest === '' ? name : `${name}\n${rest}`);

/** Real ESM from a string, so a box can be run. No eval. */
async function load(source) {
  const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`;
  return import(/* @vite-ignore */ url);
}

export default function (host) {
  let text;
  let out;

  const body = () => host.read(host.pin.note);
  const write = () => host.write(join(nameOf(body()), text.value));

  function show(value, bad = false) {
    out.classList.toggle('bad', bad);
    if (value instanceof Error) {
      out.textContent = value.message;
      return;
    }
    if (typeof value === 'string') {
      out.textContent = value;
      return;
    }
    try {
      out.textContent = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      out.textContent = String(value);
    }
  }

  async function run() {
    write();
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

  return {
    mount(box, note) {
      box.classList.add('text');
      text = document.createElement('textarea');
      text.className = 'text-body';
      text.spellcheck = false;
      text.placeholder = 'type';
      text.value = restOf(note.body);
      text.addEventListener('input', write);
      text.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          text.setRangeText('  ', text.selectionStart, text.selectionEnd, 'end');
          write();
          return;
        }
        if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void run();
        }
      });
      out = document.createElement('div');
      out.className = 'text-out';
      box.append(text, out);
    },

    focus() {
      text.focus();
    },

    blur() {
      text.blur();
      write();
    },

    save: () => write(),

    onPatch(note) {
      if (document.activeElement === text) return;
      const rest = restOf(note.body);
      if (text.value !== rest) text.value = rest;
    },

    run,
  };
}
