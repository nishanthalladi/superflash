// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { stage0 } from '../src/stage0';
import { memoryStore } from '../src/kernel/persist';
import { CREATE, DEFINE, FS, MACHINE, SHELL, TYPES } from '../src/kernel/grants';
import type { Kernel } from '../src/kernel/kernel';
import { fakeFs, runBox, until } from './help';

function host(): HTMLElement {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  return root;
}

const moduleNote = (kernel: Kernel, name: string) => kernel.types.list().find((t) => t.name === name)!.source!;
const canvasNote = (kernel: Kernel) => kernel.getPin(kernel.childPins(kernel.root)[0]!.id).note;

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('what you see when it boots', () => {
  it('is a canvas with boxes on it, and nothing else', async () => {
    const root = host();
    const { kernel, shell } = await stage0(root, memoryStore(), { fs: null });

    expect(kernel.getPin(shell!).type).toBe('canvas');
    expect(root.querySelector('.canvas-viewport')).not.toBeNull();
    expect(root.querySelectorAll('.canvas-layer > .pin').length).toBeGreaterThanOrEqual(1);
    // No toolbar, no breadcrumb, no sidebar, nothing to click but the boxes.
    expect(root.querySelector('.palette')).toBeNull();
    expect(root.querySelector('.tree')).toBeNull();
    expect(root.querySelector('.superflash-bar')).toBeNull();
    expect(root.querySelectorAll('button')).toHaveLength(0);
  });

  it('keeps the canvas itself in the document, not in src', async () => {
    const { kernel } = await stage0(host(), memoryStore(), { fs: null });
    expect(kernel.types.list().find((t) => t.name === 'canvas')!.source).toBeDefined();
    for (const name of ['box', 'code']) {
      expect(kernel.types.list().find((t) => t.name === name)!.source).toBeUndefined();
    }
  });

  it('ships the tools compiled but unpinned, one line away from being used', async () => {
    const { kernel } = await stage0(host(), memoryStore(), { fs: null });
    for (const name of ['tree', 'git-panel', 'split']) {
      expect(kernel.types.has(name)).toBe(true);
      expect(kernel.pinsOfType(name)).toHaveLength(0);
    }
  });

  it('gives a pin only the powers its Type is trusted with', async () => {
    const { kernel, shell } = await stage0(host(), memoryStore(), { fs: null });
    const box = kernel.allPins().find((p) => p.type === 'box')!;

    expect(kernel.grants.list(shell!)).toEqual([SHELL, CREATE, TYPES]);
    expect(kernel.grants.list(box.id)).toEqual([SHELL, FS, DEFINE, CREATE, TYPES, MACHINE]);
  });
});

describe('a box is a canvas too', () => {
  it('double-click goes in, Escape comes back', async () => {
    const root = host();
    const { kernel, shell } = await stage0(root, memoryStore(), { fs: null });
    const outer = canvasNote(kernel);
    const hello = kernel.childPins(outer)[0]!;
    const instance = kernel.instance(shell!) as unknown as { noteId: string };

    // The text is for editing; the whole title bar is the way in.
    root
      .querySelector<HTMLElement>('.pin .pin-face')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(instance.noteId).toBe(outer);

    root
      .querySelector<HTMLElement>('.pin .pin-grip')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(instance.noteId).toBe(hello.note);
    expect(root.querySelectorAll('.canvas-layer > .pin')).toHaveLength(0);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(instance.noteId).toBe(outer);
    expect(root.querySelectorAll('.canvas-layer > .pin')).toHaveLength(1);
  });

  it('names the note you are inside, and renames it without eating the body', async () => {
    const root = host();
    const { kernel, shell } = await stage0(root, memoryStore(), { fs: null });
    const hello = kernel.childPins(canvasNote(kernel))[0]!;
    const instance = kernel.instance(shell!) as unknown as { enter(note: string): void };
    const rest = kernel.body(hello.note).split('\n').slice(1).join('\n');

    instance.enter(hello.note);
    const head = root.querySelector<HTMLInputElement>('.canvas-head')!;
    // The first line, not the whole body: the body is not repeated here.
    expect(head.value).toBe('Instructions');

    head.value = 'renamed';
    head.dispatchEvent(new Event('input', { bubbles: true }));
    expect(kernel.body(hello.note)).toBe(`renamed\n${rest}`);
    expect(document.title).toBe('renamed');
  });

  it('puts the name on the title bar and only the rest in the box', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: null });
    const hello = kernel.childPins(canvasNote(kernel))[0]!;

    kernel.patch(hello.note, 'INSTRUCTIONS\ndouble-click empty space.');
    expect(root.querySelector<HTMLInputElement>('.pin .pin-grip')!.value).toBe('INSTRUCTIONS');
    // Not twice: the box shows what is left after the name.
    expect(root.querySelector<HTMLTextAreaElement>('.pin .box-text')!.value).toBe('double-click empty space.');
  });

  it('renames from the title bar without touching the rest', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: null });
    const hello = kernel.childPins(canvasNote(kernel))[0]!;
    kernel.patch(hello.note, 'old name\nbody stays');

    const grip = root.querySelector<HTMLInputElement>('.pin .pin-grip')!;
    grip.value = 'new name';
    grip.dispatchEvent(new Event('input', { bubbles: true }));

    expect(kernel.body(hello.note)).toBe('new name\nbody stays');
  });

  it('deletes the focused box on Cmd+Backspace, even mid-word', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: null });
    const hello = kernel.childPins(canvasNote(kernel))[0]!;

    root.querySelector<HTMLTextAreaElement>('.pin .box-text')!.focus();
    kernel.setFocus(hello.id);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', metaKey: true }));

    expect(kernel.hasPin(hello.id)).toBe(false);
  });

  it('marks a box that has boxes inside it', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: null });
    const hello = kernel.childPins(canvasNote(kernel))[0]!;

    expect(root.querySelector('.pin')!.classList.contains('deep')).toBe(false);
    kernel.pin(kernel.createNote('inside').id, hello.note, 'box');
    expect(root.querySelector('.pin')!.classList.contains('deep')).toBe(true);
  });
});

describe('editing the app from inside the app', () => {
  it('remounts the shell when the canvas Type is redefined', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: null });
    const note = moduleNote(kernel, 'canvas');

    kernel.patch(
      note,
      `export const type = { name: 'canvas', title: 'Canvas' };
       export default () => ({ mount(box) { box.textContent = 'PATCHED'; } });`,
    );
    await kernel.defineModule(note);

    expect(root.textContent).toBe('PATCHED');
    expect(root.querySelector('.canvas-viewport')).toBeNull();

    // The old canvas's window listeners went with it: Cmd+Z is nobody's now.
    const doc = JSON.stringify(kernel.toJSON());
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
    expect(JSON.stringify(kernel.toJSON())).toBe(doc);
  });

  it('runs the whole body, name line and all', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: fakeFs({ 'src/a.ts': 'a' }).fs });
    const hello = kernel.childPins(canvasNote(kernel))[0]!;
    const el = root.querySelector<HTMLElement>('.pin[data-type="box"]')!;

    // A box that is code names itself with a comment; the name still runs.
    kernel.patch(
      hello.note,
      "// what changed\nexport default async (h) => (await h.fs().git(['status', '--porcelain'])).stdout;",
    );
    expect(root.querySelector<HTMLInputElement>('.pin-grip')!.value).toBe('// what changed');
    expect(await runBox(el)).toContain('src/a.ts');
  });

  it('lets a box build a Type and place it, with no file touched', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: null });
    const hello = kernel.childPins(canvasNote(kernel))[0]!;
    const el = root.querySelector<HTMLElement>('.pin[data-type="box"]')!;

    kernel.patch(
      hello.note,
      `// make a Type
      export default async (host) => {
        const k = host.kernel();
        const note = k.createNote(\`export const type = { name: 'tick', title: 'Tick' };
          export default () => ({ mount: (el) => { el.textContent = 'tock'; } });\`);
        await k.defineModule(note.id);
        return k.pin(k.createNote('').id, host.pin.parent, 'tick').id;
      };`,
    );
    await runBox(el);
    await until(() => kernel.types.has('tick'));

    const placed = root.querySelector<HTMLElement>('.pin[data-type="tick"]')!;
    expect(placed).not.toBeNull();
    expect(placed.textContent).toContain('tock');
  });
});

describe('the safe shell', () => {
  it('takes over when the canvas will not compile', async () => {
    const store = memoryStore();
    const first = await stage0(host(), store, { fs: null });
    first.kernel.patch(moduleNote(first.kernel, 'canvas'), 'export default function ( {');
    first.save.flush();
    first.save.stop();

    const root = host();
    const second = await stage0(root, store, { fs: null });

    expect(second.shell).toBeNull();
    expect(second.kernel.types.has('canvas')).toBe(false);
    expect(root.querySelector('.safe')).not.toBeNull();
    expect(root.querySelectorAll('.safe-note textarea').length).toBe(second.kernel.modules.size);
  });

  it('?safe skips modules entirely', async () => {
    const root = host();
    const { kernel, shell } = await stage0(root, memoryStore(), { safe: true, fs: null });
    expect(shell).toBeNull();
    expect(kernel.types.has('canvas')).toBe(false);
    expect(root.querySelector('.safe')).not.toBeNull();
  });
});

describe('reload', () => {
  it('brings the document back', async () => {
    const store = memoryStore();
    const first = await stage0(host(), store, { fs: null });
    const pin = first.kernel.allPins().find((p) => p.type === 'box')!;
    first.kernel.move(pin.id, { x: 640 });
    const before = first.kernel.toJSON();
    first.save.flush();
    first.save.stop();

    const second = await stage0(host(), store, { fs: null });
    expect(second.kernel.allNotes()).toHaveLength(before.notes.length);
    expect(second.kernel.getPin(pin.id).x).toBe(640);
    expect(second.shell).not.toBeNull();
  });

  it('?fresh ignores what was stored', async () => {
    const store = memoryStore();
    const first = await stage0(host(), store, { fs: null });
    for (const p of first.kernel.childPins(canvasNote(first.kernel))) first.kernel.unpin(p.id);
    first.save.flush();
    first.save.stop();

    const fresh = await stage0(host(), store, { fresh: true, fs: null });
    expect(fresh.kernel.childPins(canvasNote(fresh.kernel)).length).toBeGreaterThanOrEqual(1);
  });
});
