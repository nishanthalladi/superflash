export const type = { name: 'terminal', title: 'Terminal' };

/**
 * Terminal. A real shell (zsh) in the repo, through the bridge, drawn by xterm —
 * the one library in the app, handed in as `globalThis.superflash.libs.xterm`
 * because a hot-loaded Type cannot import a bare specifier. The body is NOT the
 * transcript — a shell is not a document. Line one is the name. Then, in any
 * order: `term: <id>`, the living shell on the bridge this box shows (written
 * here by the box, so a reload comes back to the same shell with its scrollback),
 * and an optional `cwd: <repo-relative path>` for where a new one starts.
 */

const CSS = `
.terminal { flex: 1; min-height: 0; padding: 4px 0 0 6px; overflow: hidden; background: var(--paper); }
.terminal .xterm-viewport { background: var(--paper) !important; }
`;

export default function (host) {
  let xt;
  let handle = null;
  let watch;
  let gone = false;

  const head = () => host.read(host.pin.note).split('\n').slice(0, 4);
  const field = (key) => (head().map((l) => new RegExp(`^${key}: (.*)$`).exec(l)).find(Boolean) || [])[1] || '';

  /** Put `term: <id>` on line two, replacing an old one. */
  function remember(id) {
    const lines = host.read(host.pin.note).split('\n');
    const at = lines.findIndex((l) => l.startsWith('term: '));
    if (at > 0) lines[at] = `term: ${id}`;
    else lines.splice(1, 0, `term: ${id}`);
    host.write(lines.join('\n'));
  }

  async function open() {
    let started = false;
    const known = field('term').trim();
    xt.write(known ? 'reattaching…' : 'starting zsh…');
    try {
      handle = await host.fs().term(
        field('cwd').trim(),
        (text) => {
          if (!started) {
            started = true;
            xt.reset();
          }
          xt.write(text);
        },
        (code) => xt.write(`\r\n[exit ${code}]`),
        known || undefined,
      );
      if (gone) return handle.close(); // unmounted while the shell was starting
      if (handle.id !== known) remember(handle.id);
      handle.resize(xt.cols, xt.rows);
    } catch (err) {
      xt.write(`\r\n! ${err && err.message ? err.message : String(err)}`);
    }
  }

  return {
    mount(box) {
      if (!document.getElementById('type-terminal')) {
        const style = document.createElement('style');
        style.id = 'type-terminal';
        style.textContent = CSS;
        document.head.append(style);
      }
      box.classList.add('terminal');
      const { Terminal, FitAddon } = globalThis.superflash.libs.xterm;
      const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      xt = new Terminal({
        fontFamily: token('--mono'),
        fontSize: 12,
        cursorBlink: true,
        theme: { background: token('--paper'), foreground: token('--ink'), cursor: token('--brown'), selectionBackground: `${token('--gold')}55` },
      });
      const fit = new FitAddon();
      xt.loadAddon(fit);
      xt.open(box);
      fit.fit();
      xt.onData((data) => handle && handle.write(data));
      xt.onResize(({ cols, rows }) => handle && handle.resize(cols, rows));
      watch = new ResizeObserver(() => fit.fit());
      watch.observe(box);
      // The canvas zooms on wheel and takes Ctrl/Cmd shortcuts; in here the wheel
      // scrolls the buffer and Ctrl belongs to the shell. Cmd still reaches the canvas.
      box.addEventListener('wheel', (e) => e.stopPropagation());
      box.addEventListener('keydown', (e) => {
        if (!e.metaKey) e.stopPropagation();
      });
      void open();
    },
    focus() {
      xt.focus();
    },
    unmount() {
      // Stop watching; the shell lives on for the next box that names it.
      gone = true;
      watch.disconnect();
      if (handle) handle.close();
      xt.dispose();
    },
  };
}
