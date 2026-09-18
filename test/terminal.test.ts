// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { loadSource } from '../src/kernel/modules';
import type { TypeFactory } from '../src/kernel/type';
import terminalJs from '../seed/terminal.js?raw';
import { fakeFs, mountOne, until } from './help';

const terminal = (await loadSource(terminalJs))['default'] as TypeFactory;

beforeEach(() => document.body.replaceChildren());

describe('terminal: a shell in a box', () => {
  it('opens a shell where the body says, sends lines, shows output without escapes', async () => {
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

    expect(root.querySelector('.terminal-out')).not.toBeNull();
    expect(document.getElementById('type-terminal')).not.toBeNull();
    await until(() => terms.length === 2);
    expect(terms.map((t) => t.cwd)).toEqual(['', 'src']);

    const input = root.querySelector<HTMLTextAreaElement>('.terminal-in')!;
    input.value = 'ls';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    expect(terms[1]!.typed).toEqual(['ls\n', '\x03']);
    expect(input.value).toBe('');

    terms[1]!.emit('\x1b[?2004hls\x1b[?2004l\r\r\n\x1b[1;32mseed\x1b[0m  src\r\n\x1b]7;file://x/y\x07% ');
    expect(root.querySelector('.terminal-out')!.textContent).toBe('ls\nseed  src\n% ');

    terms[1]!.exit(0);
    expect(root.querySelector('.terminal-out')!.textContent).toContain('[exit 0]');
    expect(input.disabled).toBe(true);
  });
});
