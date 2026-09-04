// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { stage0 } from '../src/stage0';
import { memoryStore } from '../src/kernel/persist';
import { CREATE, DEFINE, FS, MACHINE, SHELL, TYPES } from '../src/kernel/grants';
import type { Kernel } from '../src/kernel/kernel';
import { fakeFs, runCell, until } from './help';

function host(): HTMLElement {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  return root;
}

const moduleNote = (kernel: Kernel, name: string) => kernel.types.list().find((t) => t.name === name)!.source!;

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('the shell is a Note', () => {
  it('boots the seed and mounts the one pin on the root Note', async () => {
    const root = host();
    const { kernel, shell } = await stage0(root, memoryStore(), { fs: null });

    expect(shell).not.toBeNull();
    expect(kernel.childPins(kernel.root)).toHaveLength(1);
    expect(kernel.getPin(shell!).type).toBe('desk');
    expect(root.querySelector('.desk-viewport')).not.toBeNull();
    expect(root.querySelector('.desk-chrome .palette')).not.toBeNull();
    expect(root.querySelectorAll('.desk-layer > .pin').length).toBeGreaterThanOrEqual(3);
  });

  it('has nothing but the kernel and two Types in src', async () => {
    const { kernel } = await stage0(host(), memoryStore(), { fs: null });
    // desk, stub and palette all came from Notes.
    for (const name of ['desk', 'stub', 'palette']) {
      expect(kernel.types.list().find((t) => t.name === name)!.source).toBeDefined();
    }
    for (const name of ['cell', 'code']) {
      expect(kernel.types.list().find((t) => t.name === name)!.source).toBeUndefined();
    }
  });

  it('gives a pin only the powers its Type is trusted with', async () => {
    const { kernel, shell } = await stage0(host(), memoryStore(), { fs: null });
    const desk = kernel.getPin(shell!);
    const cell = kernel.allPins().find((p) => p.type === 'cell')!;
    const stub = kernel.allPins().find((p) => p.type === 'stub')!;

    expect(kernel.grants.list(desk.id)).toEqual([SHELL, CREATE, TYPES]);
    expect(kernel.grants.list(cell.id)).toEqual([SHELL, FS, DEFINE, CREATE, TYPES, MACHINE]);
    expect(kernel.grants.list(stub.id)).toEqual([]);
  });
});

describe('editing the app from inside the app', () => {
  it('remounts the shell when its own module is redefined', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: null });
    const note = moduleNote(kernel, 'desk');

    kernel.patch(
      note,
      `export const type = { name: 'desk', title: 'Desk' };
       export default () => ({ mount(box) { box.textContent = 'PATCHED'; } });`,
    );
    await kernel.defineModule(note);

    expect(root.textContent).toBe('PATCHED');
    expect(root.querySelector('.desk-viewport')).toBeNull();

    // The old Desk's window listeners went with it: Cmd+Z is nobody's now.
    const doc = JSON.stringify(kernel.toJSON());
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
    expect(JSON.stringify(kernel.toJSON())).toBe(doc);
  });

  it('runs a Cell and shows what came out', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: fakeFs({ 'src/a.ts': 'a' }).fs });
    const cell = root.querySelector<HTMLElement>('.pin[data-type="cell"]')!;

    // The seeded Cell asks git what changed, through the bridge.
    expect(await runCell(cell)).toContain('src/a.ts');
    expect(kernel.types.has('desk')).toBe(true);
  });

  it('lets a Cell build a Type and place it, with no file touched', async () => {
    const root = host();
    const { kernel } = await stage0(root, memoryStore(), { fs: null });
    const cell = root.querySelector<HTMLElement>('.pin[data-type="cell"]')!;
    const source = cell.querySelector<HTMLTextAreaElement>('.cell-source')!;

    source.value = `export default async (host) => {
      const k = host.kernel();
      const note = k.createNote(\`export const type = { name: 'tick', title: 'Tick' };
        export default () => ({ mount: (box) => { box.textContent = 'tock'; } });\`);
      await k.defineModule(note.id);
      return k.pin(k.createNote('').id, host.pin.parent, 'tick').id;
    };`;
    source.dispatchEvent(new Event('input', { bubbles: true }));
    await runCell(cell);
    await until(() => kernel.types.has('tick'));

    const placed = root.querySelector<HTMLElement>('.pin[data-type="tick"]')!;
    expect(placed).not.toBeNull();
    expect(placed.textContent).toContain('tock');
  });
});

describe('the safe shell', () => {
  it('takes over when the desk module will not compile', async () => {
    const store = memoryStore();
    const first = await stage0(host(), store, { fs: null });
    first.kernel.patch(moduleNote(first.kernel, 'desk'), 'export default function ( {');
    first.save.flush();
    first.save.stop();

    const root = host();
    const second = await stage0(root, store, { fs: null });

    expect(second.shell).toBeNull();
    expect(second.kernel.types.has('desk')).toBe(false);
    expect(root.querySelector('.safe')).not.toBeNull();
    // Every module Note is editable from here, including the broken one.
    expect(root.querySelectorAll('.safe-note textarea').length).toBe(second.kernel.modules.size);
  });

  it('?safe skips modules entirely', async () => {
    const root = host();
    const { kernel, shell } = await stage0(root, memoryStore(), { safe: true, fs: null });
    expect(shell).toBeNull();
    expect(kernel.types.has('desk')).toBe(false);
    expect(root.querySelector('.safe')).not.toBeNull();
  });
});

describe('reload', () => {
  it('brings the document back', async () => {
    const store = memoryStore();
    const first = await stage0(host(), store, { fs: null });
    const pin = first.kernel.allPins().find((p) => p.type === 'stub')!;
    first.kernel.move(pin.id, { x: 640 });
    const before = first.kernel.toJSON();
    first.save.flush();
    first.save.stop();

    const second = await stage0(host(), store, { fs: null });
    expect(second.kernel.allNotes()).toHaveLength(before.notes.length);
    expect(second.kernel.allPins()).toHaveLength(before.pins.length);
    expect(second.kernel.getPin(pin.id).x).toBe(640);
    expect(second.shell).not.toBeNull();
  });

  it('?fresh ignores what was stored', async () => {
    const store = memoryStore();
    const first = await stage0(host(), store, { fs: null });
    for (const p of first.kernel.childPins(first.kernel.getPin(first.shell!).note)) first.kernel.unpin(p.id);
    first.save.flush();
    first.save.stop();

    const fresh = await stage0(host(), store, { fresh: true, fs: null });
    expect(fresh.kernel.childPins(fresh.kernel.getPin(fresh.shell!).note).length).toBeGreaterThanOrEqual(3);
  });
});
