// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { loadSource } from '../src/kernel/modules';
import type { TypeFactory } from '../src/kernel/type';
import terminalJs from '../seed/terminal.js?raw';
import { fakeFs, mountOne, until } from './help';

const terminal = (await loadSource(terminalJs))['default'] as TypeFactory;

/** Just enough of xterm's surface for the Type to lean on. */
const opened: FakeTerminal[] = [];
class FakeTerminal {
  cols = 80;
  rows = 24;
  written = '';
  el: HTMLElement | null = null;
  disposed = false;
  private data: ((d: string) => void)[] = [];
  constructor(public options: Record<string, unknown>) {
    opened.push(this);
  }
  open(el: HTMLElement) { this.el = el; }
  write(s: string) { this.written += s; }
  reset() { this.written = ''; }
  onData(cb: (d: string) => void) { this.data.push(cb); }
  onResize() {}
  loadAddon() {}
  focus() {}
  dispose() { this.disposed = true; }
  type(d: string) { for (const cb of this.data) cb(d); }
}
class FakeFit { fit() {} }
Object.assign(globalThis, {
  superflash: { libs: { xterm: { Terminal: FakeTerminal, FitAddon: FakeFit } } },
  ResizeObserver: class { observe() {} disconnect() {} },
});

beforeEach(() => {
  document.body.replaceChildren();
  opened.length = 0;
});

describe('terminal: a shell in a box', () => {
  it('opens xterm where the body says, streams bytes in, sends keys out, closes with the box', async () => {
    const k = new Kernel();
    const { fs, terms } = fakeFs();
    k.fs = fs;
    const root = document.createElement('div');
    document.body.append(root);
    const { pin, instance } = mountOne(k, root, 'terminal', terminal);
    // The body says where to start, so it has to be there before the mount.
    k.patch(k.getPin(pin).note, 'Shell\ncwd: src');
    root.replaceChildren();
    instance.mount(root, k.note(k.getPin(pin).note));

    expect(document.getElementById('type-terminal')).not.toBeNull();
    expect(opened).toHaveLength(2);
    const xt = opened[1]!;
    expect(xt.el).toBe(root);
    expect(xt.options['theme']).toMatchObject({ background: expect.any(String) });
    expect(xt.written).toContain('starting zsh');
    await until(() => terms.length === 2);
    expect(terms.map((t) => t.cwd)).toEqual(['', 'src']);
    await until(() => terms[1]!.size.length === 2);
    expect(terms[1]!.size).toEqual([80, 24]);

    xt.type('ls\r');
    xt.type('\x03');
    expect(terms[1]!.typed).toEqual(['ls\r', '\x03']);

    terms[1]!.emit('\x1b[1;32mseed\x1b[0m  src\r\n% ');
    expect(xt.written).toBe('\x1b[1;32mseed\x1b[0m  src\r\n% '); // nothing stripped; the wait line is gone

    instance.unmount!(); // close() on the fake handle exits the shell
    expect(xt.written).toContain('[exit 0]');
    expect(xt.disposed).toBe(true);
  });
});
