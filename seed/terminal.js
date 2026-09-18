export const type = { name: 'terminal', title: 'Terminal' };

/**
 * Terminal. A real shell (zsh) in the repo, through the bridge, drawn by xterm —
 * the one library in the app, handed in as `globalThis.superflash.libs.xterm`
 * because a hot-loaded Type cannot import a bare specifier. The body is NOT the
 * transcript — a shell is not a document. Line one is the name; an optional
 * line two `cwd: <repo-relative path>` says where to start.
 */

const CSS = `
.terminal { flex: 1; min-height: 0; padding: 4px 0 0 6px; overflow: hidden; background: var(--paper); }
.terminal .xterm-viewport { background: var(--paper) !important; }
`;

export default function (host) {
  let xt;
  let handle = null;
  let watch;

  const cwd = () => (/^cwd: (.*)$/.exec(host.read(host.pin.note).split('\n')[1] || '') || [])[1] || '';

  async function open() {
    let started = false;
    xt.write('starting zsh…');
    try {
      handle = await host.fs().term(
        cwd().trim(),
        (text) => {
          if (!started) {
            started = true;
            xt.reset();
          }
          xt.write(text);
        },
        (code) => xt.write(`\r\n[exit ${code}]`),
      );
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
      watch.disconnect();
      if (handle) handle.close();
      xt.dispose();
    },
  };
}
