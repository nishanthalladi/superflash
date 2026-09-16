import type { Kernel } from './kernel/kernel';
import type { NoteId } from './kernel/model';

/**
 * The shell of last resort. Mounted when the `canvas` module will not compile or
 * will not mount — a bare textarea per module Note, and a Run button. Ugly on
 * purpose: it only has to let you fix the Note that broke.
 *
 * Reached automatically, or with `?safe=1`.
 */
export function safeShell(kernel: Kernel, mountPoint: HTMLElement, why: string): void {
  mountPoint.replaceChildren();
  const root = document.createElement('div');
  root.className = 'safe';
  mountPoint.append(root);

  const head = document.createElement('div');
  head.className = 'safe-head';
  head.textContent = `safe shell — ${why}`;
  root.append(head);

  const note = (id: NoteId): void => {
    const wrap = document.createElement('div');
    wrap.className = 'safe-note';

    const label = document.createElement('div');
    label.className = 'safe-label';
    label.textContent = id;

    const text = document.createElement('textarea');
    text.spellcheck = false;
    text.value = kernel.body(id);
    text.addEventListener('input', () => kernel.patch(id, text.value));

    const status = document.createElement('span');
    const run = document.createElement('button');
    run.textContent = 'run';
    run.onclick = async () => {
      kernel.patch(id, text.value);
      try {
        const info = await kernel.defineModule(id);
        status.textContent = `registered ${info.name} — reload to use it`;
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
      }
    };

    const tools = document.createElement('div');
    tools.className = 'safe-tools';
    tools.append(run, status);
    wrap.append(label, text, tools);
    root.append(wrap);
  };

  for (const id of kernel.modules) note(id);

  const links = document.createElement('div');
  links.className = 'safe-tools';
  const reload = document.createElement('button');
  reload.textContent = 'reload';
  reload.onclick = () => location.reload();
  const fresh = document.createElement('button');
  fresh.textContent = 'start from the shipped seed';
  fresh.title = 'Throws away every change stored in this browser';
  fresh.onclick = () => {
    if (confirm('Discard the stored document and boot the shipped seed?')) {
      location.search = '?fresh=1';
    }
  };
  links.append(reload, fresh);
  root.append(links);
  // ponytail: no per-Note "reset to shipped" — needs a note→file map that only
  // eject knows. Add it if a bad edit to canvas.js ever costs someone real work.
}
