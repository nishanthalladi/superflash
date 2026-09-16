// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { box } from '../src/types/box';
import { Denied, SHELL } from '../src/kernel/grants';
import type { Host } from '../src/kernel/type';
import { runBox, until } from './help';

function setup(body: string, grants = [SHELL]) {
  const kernel = new Kernel();
  kernel.types.define('box', box);
  const desk = kernel.createNote('desk');
  const note = kernel.createNote(body);
  const pin = kernel.pin(note.id, desk.id, 'box');
  kernel.grants.give(pin.id, ...grants);
  const el = document.createElement('div');
  document.body.replaceChildren(el);
  const instance = kernel.types.get('box')(kernel.host(pin.id));
  kernel.attach(pin.id, instance);
  instance.mount(el, kernel.note(note.id));
  return { kernel, el, pin, note };
}

const run = runBox;

beforeEach(() => document.body.replaceChildren());

describe('a box runs its body', () => {
  it('calls the default export with its Host', async () => {
    const { el } = setup('export default (host) => host.pin.type;');
    expect(await run(el)).toBe('"box"');
  });

  it('takes `out` when there is no default export', async () => {
    const { el } = setup('export const out = { a: 1 };');
    expect(await run(el)).toContain('"a": 1');
  });

  it('awaits, because the body is a real module', async () => {
    const { el } = setup('export default async () => { await 0; return 41 + 1; };');
    expect(await run(el)).toBe('42');
  });

  it('appends a DOM node instead of printing it', async () => {
    const { el } = setup(`export default () => {
      const el = document.createElement('b');
      el.textContent = 'live';
      return el;
    };`);
    await run(el);
    expect(el.querySelector('.box-out b')!.textContent).toBe('live');
  });

  it('shows a throw and stays alive', async () => {
    const { el } = setup("export default () => { throw new Error('nope'); };");
    expect(await run(el)).toContain('nope');
    expect(el.querySelector('.box-out')!.classList.contains('bad')).toBe(true);
    expect(el.querySelector('.box-text')).not.toBeNull();
  });

  it('shows a syntax error rather than dying', async () => {
    const { el } = setup('export default ( {');
    expect(await run(el)).not.toBe('');
    expect(el.querySelector('.box-out')!.classList.contains('bad')).toBe(true);
  });
});

describe("a box's powers", () => {
  it('reaches the kernel, because it holds `shell`', async () => {
    const { el } = setup('export default (host) => host.kernel().allPins().length;');
    expect(await run(el)).toBe('1');
  });

  it('is denied the kernel without the grant', async () => {
    const { el } = setup('export default (host) => host.kernel().allPins().length;', []);
    expect(await run(el)).toContain('denied: shell');
  });

  it('writes its own body as you type', () => {
    const { kernel, el, note } = setup('a name');
    const source = el.querySelector<HTMLTextAreaElement>('.box-text')!;
    // The name line is the canvas's title bar; the box edits what is under it.
    expect(source.value).toBe('');
    source.value = 'typed';
    source.dispatchEvent(new Event('input', { bubbles: true }));
    expect(kernel.body(note.id)).toBe('a name\ntyped');
  });

  it('never stores its output', async () => {
    // Build the string, so finding it in the document can only mean the output.
    const { kernel, el } = setup('export default () => ["vis", "ible"].join("");');
    expect(await run(el)).toBe('"visible"');
    expect(JSON.stringify(kernel.toJSON())).not.toContain('visible');
  });
});

describe('Cmd+Enter moves down the stack', () => {
  it('focuses the next pin below, by y', async () => {
    const kernel = new Kernel();
    kernel.types.define('box', box);
    const desk = kernel.createNote('desk');
    const el = document.createElement('div');
    document.body.replaceChildren(el);

    const here = kernel.pin(kernel.createNote('export default () => 1;').id, desk.id, 'box', { y: 0 });
    const below = kernel.pin(kernel.createNote('').id, desk.id, 'box', { y: 400 });
    kernel.grants.give(here.id, SHELL);

    const instance = kernel.types.get('box')(kernel.host(here.id));
    kernel.attach(here.id, instance);
    instance.mount(el, kernel.note(here.note));

    el
      .querySelector<HTMLTextAreaElement>('.box-text')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await until(() => kernel.focus() !== null);

    expect(kernel.focus()).toBe(below.id);
  });
});

describe('the grant is real', () => {
  it('throws Denied from the Host, not from the box', () => {
    const kernel = new Kernel();
    kernel.types.define('box', box);
    const desk = kernel.createNote('desk');
    const pin = kernel.pin(kernel.createNote('').id, desk.id, 'box');
    const host: Host = kernel.host(pin.id);
    expect(() => host.kernel()).toThrow(Denied);
  });
});
