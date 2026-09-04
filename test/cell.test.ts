// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { cell } from '../src/types/cell';
import { Denied, SHELL } from '../src/kernel/grants';
import type { Host } from '../src/kernel/type';
import { runCell, until } from './help';

function setup(body: string, grants = [SHELL]) {
  const kernel = new Kernel();
  kernel.types.define('cell', cell);
  const desk = kernel.createNote('desk');
  const note = kernel.createNote(body);
  const pin = kernel.pin(note.id, desk.id, 'cell');
  kernel.grants.give(pin.id, ...grants);
  const box = document.createElement('div');
  document.body.replaceChildren(box);
  const instance = kernel.types.get('cell')(kernel.host(pin.id));
  kernel.attach(pin.id, instance);
  instance.mount(box, kernel.note(note.id));
  return { kernel, box, pin, note };
}

const run = runCell;

beforeEach(() => document.body.replaceChildren());

describe('a Cell runs its body', () => {
  it('calls the default export with its Host', async () => {
    const { box } = setup('export default (host) => host.pin.type;');
    expect(await run(box)).toBe('"cell"');
  });

  it('takes `out` when there is no default export', async () => {
    const { box } = setup('export const out = { a: 1 };');
    expect(await run(box)).toContain('"a": 1');
  });

  it('awaits, because the body is a real module', async () => {
    const { box } = setup('export default async () => { await 0; return 41 + 1; };');
    expect(await run(box)).toBe('42');
  });

  it('appends a DOM node instead of printing it', async () => {
    const { box } = setup(`export default () => {
      const el = document.createElement('b');
      el.textContent = 'live';
      return el;
    };`);
    await run(box);
    expect(box.querySelector('.cell-out b')!.textContent).toBe('live');
  });

  it('shows a throw and stays alive', async () => {
    const { box } = setup("export default () => { throw new Error('nope'); };");
    expect(await run(box)).toContain('nope');
    expect(box.querySelector('.cell-out')!.classList.contains('bad')).toBe(true);
    expect(box.querySelector('.cell-source')).not.toBeNull();
  });

  it('shows a syntax error rather than dying', async () => {
    const { box } = setup('export default ( {');
    expect(await run(box)).not.toBe('');
    expect(box.querySelector('.cell-out')!.classList.contains('bad')).toBe(true);
  });
});

describe("a Cell's powers", () => {
  it('reaches the kernel, because it holds `shell`', async () => {
    const { box } = setup('export default (host) => host.kernel().allPins().length;');
    expect(await run(box)).toBe('1');
  });

  it('is denied the kernel without the grant', async () => {
    const { box } = setup('export default (host) => host.kernel().allPins().length;', []);
    expect(await run(box)).toContain('denied: shell');
  });

  it('writes its own body as you type', () => {
    const { kernel, box, note } = setup('before');
    const source = box.querySelector<HTMLTextAreaElement>('.cell-source')!;
    source.value = 'after';
    source.dispatchEvent(new Event('input', { bubbles: true }));
    expect(kernel.body(note.id)).toBe('after');
  });

  it('never stores its output', async () => {
    // Build the string, so finding it in the document can only mean the output.
    const { kernel, box } = setup('export default () => ["vis", "ible"].join("");');
    expect(await run(box)).toBe('"visible"');
    expect(JSON.stringify(kernel.toJSON())).not.toContain('visible');
  });
});

describe('Cmd+Enter moves down the stack', () => {
  it('focuses the next pin below, by y', async () => {
    const kernel = new Kernel();
    kernel.types.define('cell', cell);
    const desk = kernel.createNote('desk');
    const box = document.createElement('div');
    document.body.replaceChildren(box);

    const here = kernel.pin(kernel.createNote('export default () => 1;').id, desk.id, 'cell', { y: 0 });
    const below = kernel.pin(kernel.createNote('').id, desk.id, 'cell', { y: 400 });
    kernel.grants.give(here.id, SHELL);

    const instance = kernel.types.get('cell')(kernel.host(here.id));
    kernel.attach(here.id, instance);
    instance.mount(box, kernel.note(here.note));

    box
      .querySelector<HTMLTextAreaElement>('.cell-source')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await until(() => kernel.focus() !== null);

    expect(kernel.focus()).toBe(below.id);
  });
});

describe('the grant is real', () => {
  it('throws Denied from the Host, not from the Cell', () => {
    const kernel = new Kernel();
    kernel.types.define('cell', cell);
    const desk = kernel.createNote('desk');
    const pin = kernel.pin(kernel.createNote('').id, desk.id, 'cell');
    const host: Host = kernel.host(pin.id);
    expect(() => host.kernel()).toThrow(Denied);
  });
});
