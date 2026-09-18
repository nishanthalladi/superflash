import { describe, expect, it, vi } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { readGrant } from '../src/kernel/grants';
import {
  DOC_KEY,
  SNAP_KEY,
  autosave,
  memoryStore,
  readDoc,
  snapshot,
  snapshots,
  writeDoc,
} from '../src/kernel/persist';
import { plain as stub } from './help';

function kernel() {
  const k = new Kernel();
  k.types.define('stub', stub);
  const desk = k.createNote('desk');
  k.root = desk.id;
  return { k, desk };
}

describe('round trip', () => {
  it('brings back notes, pins, geometry, focus, grants and modules', () => {
    const { k, desk } = kernel();
    const a = k.createNote('a body');
    const shared = k.createNote('shared');
    const pinA = k.pin(a.id, desk.id, 'stub', { x: 16, y: 24, width: 200, height: 120 });
    k.pin(shared.id, desk.id, 'stub', { x: 300 });
    k.pin(shared.id, desk.id, 'stub', { x: 600 });
    k.grants.give(pinA.id, readGrant(shared.id));
    k.modules.add(a.id);
    k.setFocus(pinA.id);

    const store = memoryStore();
    writeDoc(store, k.toJSON());

    const next = new Kernel();
    next.types.define('stub', stub);
    next.load(readDoc(store)!);

    expect(next.root).toBe(desk.id);
    expect(next.allNotes()).toHaveLength(3);
    expect(next.allPins()).toHaveLength(3);
    expect(next.body(a.id)).toBe('a body');
    expect(next.getPin(pinA.id)).toMatchObject({ x: 16, y: 24, width: 200, height: 120 });
    expect(next.pinsOf(shared.id)).toHaveLength(2);
    expect(next.focus()).toBe(pinA.id);
    expect(next.grants.list(pinA.id)).toEqual([readGrant(shared.id)]);
    expect([...next.modules]).toEqual([a.id]);
  });

  it('never reissues a stored id', () => {
    const { k, desk } = kernel();
    for (let i = 0; i < 5; i += 1) k.pin(k.createNote(`n${i}`).id, desk.id, 'stub');
    const doc = k.toJSON();
    const stored = new Set([...doc.notes.map((n) => n.id), ...doc.pins.map((p) => p.id)]);

    const next = new Kernel();
    next.types.define('stub', stub);
    next.load(doc);
    for (let i = 0; i < 20; i += 1) {
      const fresh = next.createNote('new');
      expect(stored.has(fresh.id)).toBe(false);
      expect(stored.has(next.pin(fresh.id, next.root, 'stub').id)).toBe(false);
    }
  });

  it('drops pins whose Note went missing rather than keeping a dangling one', () => {
    const { k, desk } = kernel();
    const doomed = k.createNote('gone');
    k.pin(doomed.id, desk.id, 'stub');
    const doc = k.toJSON();
    doc.notes = doc.notes.filter((n) => n.id !== doomed.id);

    const next = new Kernel();
    next.types.define('stub', stub);
    next.load(doc);
    expect(next.allPins()).toHaveLength(0);
  });

  it('rejects junk instead of throwing at boot', () => {
    expect(readDoc(memoryStore({ [DOC_KEY]: 'not json' }))).toBeNull();
    expect(readDoc(memoryStore({ [DOC_KEY]: '{"version":99}' }))).toBeNull();
    expect(readDoc(memoryStore())).toBeNull();
  });
});

describe('autosave', () => {
  it('debounces, then writes the current document', () => {
    vi.useFakeTimers();
    try {
      const { k, desk } = kernel();
      const store = memoryStore();
      autosave(k, store, { delay: 250 });

      const note = k.createNote('typed');
      k.pin(note.id, desk.id, 'stub');
      k.patch(note.id, 'typed more');
      expect(store.getItem(DOC_KEY)).toBeNull();

      vi.advanceTimersByTime(250);
      const doc = readDoc(store)!;
      expect(doc.notes.find((n) => n.id === note.id)?.body).toBe('typed more');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush writes immediately, and stop stops saving', () => {
    vi.useFakeTimers();
    try {
      const { k, desk } = kernel();
      const store = memoryStore();
      const save = autosave(k, store);

      k.pin(k.createNote('one').id, desk.id, 'stub');
      save.flush();
      expect(readDoc(store)!.pins).toHaveLength(1);

      save.stop();
      k.pin(k.createNote('two').id, desk.id, 'stub');
      vi.advanceTimersByTime(1000);
      expect(readDoc(store)!.pins).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('snapshots', () => {
  it('keeps the last five documents, newest first', () => {
    const store = memoryStore();
    const { k, desk } = kernel();
    for (let i = 0; i < 7; i += 1) {
      k.pin(k.createNote(`n${i}`).id, desk.id, 'stub');
      snapshot(store, k.toJSON());
    }
    const kept = snapshots(store);
    expect(kept).toHaveLength(5);
    expect(kept[0]!.pins).toHaveLength(7);
    expect(kept[4]!.pins).toHaveLength(3);
    expect(store.getItem(`${SNAP_KEY}:0`)).not.toBeNull();
  });
});

describe('the store holds the notebook, not the repo', () => {
  it('drops file: notes and their pins, and survives a full store', async () => {
    const { Kernel } = await import('../src/kernel/kernel');
    const { forStore, writeDoc, snapshot, readDoc } = await import('../src/kernel/persist');
    const k = new Kernel();
    const root = k.createNote('root');
    k.root = root.id;
    k.createNote('a file', 'file:src/a.ts');
    k.types.define('text', () => ({ mount() {} }));
    k.pin('file:src/a.ts', root.id, 'text');
    const mine = k.createNote('mine');
    k.pin(mine.id, root.id, 'text');
    const slim = forStore(k.toJSON());
    expect(slim.notes.map((n) => n.id)).toEqual([root.id, mine.id]);
    expect(slim.pins).toHaveLength(1);

    const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => undefined };
    expect(() => writeDoc(full, k.toJSON())).not.toThrow();
    expect(() => snapshot(full, k.toJSON())).not.toThrow();
    expect(readDoc(full)).toBeNull();
  });
});
