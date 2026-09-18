export const type = {
  name: 'text',
  title: 'Text',
  icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4 H13 M3 8 H13 M3 12 H9"/></svg>',
};

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
   * One checkbox per task line, over its `[ ]`. Long lines wrap, so the row of a
   * line is not its index: a hidden mirror of the textarea, same width and font,
   * tells us where each line actually landed.
   */
  function drawTasks() {
    gutter.replaceChildren();
    const lines = text.value.split('\n');
    if (!lines.some((l) => TASK.test(l))) return;
    const cs = getComputedStyle(text);
    const mirror = document.createElement('div');
    mirror.className = 'text-mirror';
    mirror.style.cssText = `font:${cs.font};letter-spacing:${cs.letterSpacing};padding:${cs.padding};width:${text.clientWidth}px;line-height:${cs.lineHeight};tab-size:${cs.tabSize}`;
    const marks = [];
    lines.forEach((l, i) => {
      const m = TASK.exec(l);
      const row = document.createElement('div');
      if (m) {
        const before = document.createElement('span');
        before.textContent = `${m[1]}- `;
        const box = document.createElement('span');
        box.textContent = `[${m[2]}]`;
        const after = document.createElement('span');
        after.textContent = l.slice(m[0].length - 1) || ' ';
        row.append(before, box, after);
        marks.push({ i, box, done: m[2] === 'x' });
      } else row.textContent = l || ' ';
      mirror.append(row);
    });
    text.parentElement.append(mirror);
    const base = mirror.getBoundingClientRect();
    for (const { i, box, done } of marks) {
      const r = box.getBoundingClientRect();
      const cover = document.createElement('label');
      cover.className = 'text-task';
      cover.style.top = `${r.top - base.top - text.scrollTop}px`;
      cover.style.left = `${r.left - base.left - 1}px`;
      cover.style.width = `${r.width + 2}px`;
      cover.style.height = `${r.height}px`;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = done;
      cover.addEventListener('pointerdown', (e) => e.stopPropagation());
      input.addEventListener('change', () => {
        const all = text.value.split('\n');
        all[i] = all[i].replace(TASK, `$1- [${input.checked ? 'x' : ' '}] `);
        text.value = all.join('\n');
        write();
      });
      cover.append(input);
      gutter.append(cover);
    }
    mirror.remove();
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
      if (typeof ResizeObserver === 'function') new ResizeObserver(drawTasks).observe(text);
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
