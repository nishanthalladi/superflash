// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { stage0 } from '../src/stage0';
import { memoryStore } from '../src/kernel/persist';
import { applyDoc, forDisk, placed } from '../src/docfile';
import type { Doc } from '../src/kernel/kernel';
import { fakeFs, until } from './help';

function host(): HTMLElement {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  return root;
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('the document on disk', () => {
  it('is written after a change, without the repo mirror in it', async () => {
    const repo = fakeFs({ 'src/a.ts': 'a' });
    const { kernel, doc } = await stage0(host(), memoryStore(), { fs: repo.fs });
    expect(kernel.hasNote('file:src/a.ts')).toBe(true);

    kernel.createNote('a thought', 'note_x');
    await doc!.flush();

    const onDisk = JSON.parse(repo.doc()!) as Doc;
    expect(onDisk.notes.map((n) => n.id)).toContain('note_x');
    expect(onDisk.notes.some((n) => n.id.startsWith('file:'))).toBe(false);
  });

  it('an outside edit — an agent making a box — shows up live, and undoes', async () => {
    const repo = fakeFs();
    const root = host();
    const { kernel, doc, shell } = await stage0(root, memoryStore(), { fs: repo.fs });
    await doc!.flush();
    const surface = kernel.getPin(shell!).note;
    const before = kernel.childPins(surface).length;

    const edited = JSON.parse(repo.doc()!) as Doc;
    edited.notes.push({ id: 'note_groceries', body: 'groceries\nmilk, eggs' });
    edited.pins.push({ id: 'pin_groceries', note: 'note_groceries', parent: surface, type: 'text', x: 400, y: 200, width: 260, height: 140 });
    repo.outsideDoc(JSON.stringify(edited));
    await doc!.pull();

    expect(kernel.childPins(surface)).toHaveLength(before + 1);
    expect(kernel.body('note_groceries')).toBe('groceries\nmilk, eggs');
    await until(() => root.querySelector('.pin[data-pin="pin_groceries"]') !== null);

    kernel.journal.undo();
    expect(kernel.hasPin('pin_groceries')).toBe(false);
  });

  it('disk wins on boot', async () => {
    const repo = fakeFs();
    const store = memoryStore();
    const first = await stage0(host(), store, { fs: repo.fs });
    first.kernel.createNote('only on disk', 'note_d');
    await first.doc!.flush();
    first.save.flush();
    first.save.stop();
    first.doc!.stop();

    // The browser forgets; the repo remembers.
    const second = await stage0(host(), memoryStore(), { fs: repo.fs });
    expect(second.kernel.hasNote('note_d')).toBe(true);
  });

  it('applyDoc moves, removes, and leaves the mirror alone', async () => {
    const repo = fakeFs({ 'x.md': 'x' });
    const { kernel, shell } = await stage0(host(), memoryStore(), { fs: repo.fs });
    const surface = kernel.getPin(shell!).note;
    const pin = kernel.childPins(surface)[0]!;
    const doc = forDisk(kernel.toJSON());
    doc.pins.find((p) => p.id === pin.id)!.x = 999;
    applyDoc(kernel, doc);
    expect(kernel.getPin(pin.id).x).toBe(999);

    doc.pins = doc.pins.filter((p) => p.id !== pin.id);
    doc.notes = doc.notes.filter((n) => n.id !== pin.note);
    applyDoc(kernel, doc);
    expect(kernel.hasPin(pin.id)).toBe(false);
    expect(kernel.hasNote(pin.note)).toBe(false);
    expect(kernel.hasNote('file:x.md')).toBe(true);
  });
});

describe('place: layout without arithmetic', () => {
  it('right-of and below land beside the named pin, on its parent', async () => {
    const repo = fakeFs();
    const { kernel, shell } = await stage0(host(), memoryStore(), { fs: repo.fs });
    const surface = kernel.getPin(shell!).note;
    const by = kernel.childPins(surface)[0]!;
    const base = { id: 'pin_p', note: by.note, parent: 'wrong', type: 'text', x: 0, y: 0, width: 200, height: 100 };

    expect(placed(kernel, { ...base, place: `right-of ${by.id}` })).toMatchObject({
      x: by.x + by.width + 24, y: by.y, parent: surface,
    });
    expect(placed(kernel, { ...base, place: `below ${by.id}` })).toMatchObject({ x: by.x, y: by.y + by.height + 24 });
    expect('place' in placed(kernel, { ...base, place: `below ${by.id}` })).toBe(false);
    // Unknown pin: the field is ignored and x, y stand.
    expect(placed(kernel, { ...base, place: 'below pin_nope' })).toMatchObject({ x: 0, y: 0, parent: 'wrong' });
  });
});

describe('fresh does not clobber the repo', () => {
  it('a fresh boot in a second browser still reads the document on disk', async () => {
    const repo = fakeFs();
    const first = await stage0(host(), memoryStore(), { fs: repo.fs });
    first.kernel.createNote('mine', 'note_mine');
    await first.doc!.flush();
    first.doc!.stop();

    const second = await stage0(host(), memoryStore(), { fs: repo.fs, fresh: true });
    expect(second.kernel.hasNote('note_mine')).toBe(true);
    await second.doc!.flush();
    expect((JSON.parse(repo.doc()!) as Doc).notes.some((n) => n.id === 'note_mine')).toBe(true);
  });
});
