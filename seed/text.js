export const type = { name: 'text', title: 'Text' };

/**
 * Text. The plainest Type there is: everything after the name line, in a
 * textarea. Shift+Enter runs the body as a module and shows what came out, so a
 * text box is also the place you type code to run.
 *
 * The name (line one) is drawn by the canvas this pin sits on, not here — the
 * bar around a box is the same for every Type.
 *
 * A line that starts `- [ ]` or `- [x]` is a task. Click the box in the gutter
 * to flip it; the text is the truth, so an agent can tick one by editing text.
 */

const TASK = /^(\s*)- \[( |x)\] /;

const restOf = (body) => body.split('\n').slice(1).join('\n');
const nameOf = (body) => body.split('\n')[0] || '';
const join = (name, rest) => (rest === '' ? name : `${name}\n${rest}`);

/** How wide this exact text is in this font — a proportional face has no `ch` to trust. */
const widths = new Map();
function textWidth(font, text) {
  const key = `${font}\u0000${text}`;
  if (!widths.has(key)) {
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${font}`;
    probe.textContent = text;
    document.body.append(probe);
    widths.set(key, probe.getBoundingClientRect().width || text.length * 7);
    probe.remove();
  }
  return widths.get(key);
}

/** Real ESM from a string, so a box can be run. No eval. */
async function load(source) {
  const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`;
  return import(/* @vite-ignore */ url);
}

export default function (host) {
  let text;
  let out;
  let gutter;

  const body = () => host.read(host.pin.note);
  const write = () => {
    host.write(join(nameOf(body()), text.value));
    drawTasks();
  };

  /**
   * One checkbox per task line, laid exactly over its `[ ]` so the brackets are
   * covered and the box reads as part of the line. Long lines that wrap put the
   * later boxes off by a line; ponytail: fine for a list, revisit for prose.
   */
  function drawTasks() {
    gutter.replaceChildren();
    const lines = text.value.split('\n');
    const cs = getComputedStyle(text);
    const line = parseFloat(cs.lineHeight) || 20;
    const top = parseFloat(cs.paddingTop) || 0;
    const left = parseFloat(cs.paddingLeft) || 0;
    lines.forEach((l, i) => {
      const m = TASK.exec(l);
      if (!m) return;
      const cover = document.createElement('label');
      cover.className = 'text-task';
      cover.style.top = `${top + i * line - text.scrollTop}px`;
      // Cover exactly the `- [ ] ` prefix, wherever this font puts its right edge.
      cover.style.left = `${left + textWidth(cs.font, m[1])}px`;
      cover.style.width = `${textWidth(cs.font, m[0]) - textWidth(cs.font, m[1])}px`;
      cover.style.justifyContent = 'flex-start';
      cover.style.paddingLeft = `${textWidth(cs.font, '- ')}px`;
      cover.style.height = `${line}px`;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = m[2] === 'x';
      cover.addEventListener('pointerdown', (e) => e.stopPropagation());
      box.addEventListener('change', () => {
        const all = text.value.split('\n');
        all[i] = all[i].replace(TASK, `$1- [${box.checked ? 'x' : ' '}] `);
        text.value = all.join('\n');
        write();
      });
      cover.append(box);
      gutter.append(cover);
    });
  }

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
      gutter = document.createElement('div');
      gutter.className = 'text-gutter';
      const wrap = document.createElement('div');
      wrap.className = 'text-wrap';
      wrap.append(text, gutter);
      text.addEventListener('scroll', drawTasks);
      box.append(wrap, out);
      drawTasks();
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
      drawTasks();
    },

    run,
  };
}
