export const type = { name: 'terminal', title: 'Terminal' };

/**
 * Terminal. A real shell (zsh) in the repo, through the bridge. The body is NOT
 * the transcript — a shell is not a document. Line one is the name; an optional
 * line two `cwd: <repo-relative path>` says where to start.
 *
 * Output is a <pre> with escape codes stripped; the line at the bottom sends on
 * Enter, and Ctrl+C sends ^C. No xterm: what a dumb terminal shows is enough for
 * a notebook.
 */

// CSI, OSC (title, cwd), and the lone two-byte escapes; plus \r, which only
// ever precedes \n or repaints a line we already have.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])|\r/g;

const CSS = `
.terminal { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--paper); }
.terminal-out { flex: 1; min-height: 0; margin: 0; padding: 10px 12px; overflow: auto; color: var(--ink);
  font-family: var(--mono); font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-all; }
.terminal-in { flex: none; resize: none; border: 0; border-top: 1px solid var(--edge); padding: 6px 12px;
  background: var(--paper-2); color: var(--ink); font-family: var(--mono); font-size: 12px; }
.terminal-in:focus { outline: none; }
.terminal-in::placeholder { color: var(--dim); }
`;

export default function (host) {
  let out;
  let input;
  let term = null;

  const cwd = () => (/^cwd: (.*)$/.exec(host.read(host.pin.note).split('\n')[1] || '') || [])[1] || '';

  function print(text) {
    out.textContent += text.replace(ANSI, '');
    out.scrollTop = out.scrollHeight;
  }

  async function open() {
    try {
      term = await host.fs().term(cwd().trim(), print, (code) => {
        print(`\n[exit ${code}]`);
        input.disabled = true;
      });
    } catch (err) {
      print(`! ${err && err.message ? err.message : String(err)}`);
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
      out = document.createElement('pre');
      out.className = 'terminal-out';
      input = document.createElement('textarea');
      input.className = 'terminal-in';
      input.rows = 1;
      input.spellcheck = false;
      input.placeholder = '$';
      input.addEventListener('keydown', (e) => {
        if (!term) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          term.write(`${input.value}\n`);
          input.value = '';
        } else if (e.key === 'c' && e.ctrlKey) {
          e.preventDefault();
          term.write('\x03');
        }
      });
      box.append(out, input);
      void open();
    },
    focus() {
      input.focus();
    },
    unmount() {
      if (term) term.close();
    },
  };
}
