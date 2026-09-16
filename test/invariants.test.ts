import { describe, expect, it, vi } from 'vitest';
import { Cycle, Kernel } from '../src/kernel/kernel';
import { Denied, readGrant } from '../src/kernel/grants';
import type { Host, TypeInstance } from '../src/kernel/type';
import { SANDBOX_PREAMBLE, startMachine } from '../src/kernel/machine';
import type { WorkerLike } from '../src/kernel/machine';
import type { Fact, Note } from '../src/kernel/model';

/** A headless Type: records everything, touches no DOM. */
function probe(host: Host): TypeInstance & {
  facts: Fact[];
  keys: string[];
  patches: string[];
  host: Host;
} {
  const facts: Fact[] = [];
  const keys: string[] = [];
  const patches: string[] = [];
  return {
    host,
    facts,
    keys,
    patches,
    mount() {},
    onSpine: (f) => facts.push(f),
    onKey: (e) => keys.push(e.key),
    onPatch: (n: Note) => patches.push(n.body),
  };
}

function fresh() {
  const k = new Kernel();
  k.types.define('probe', probe);
  const desk = k.createNote('desk');
  return { k, desk };
}

/** Attach a headless instance the way the canvas would. */
function live(k: Kernel, pinId: string) {
  const inst = probe(k.host(pinId)) as ReturnType<typeof probe>;
  k.attach(pinId, inst);
  return inst;
}

describe('1. every Note has exactly one body', () => {
  it('patching is the only way to change it, and there is one copy', () => {
    const { k } = fresh();
    const n = k.createNote('one');
    expect(k.note(n.id).body).toBe('one');
    k.patch(n.id, 'two');
    expect(k.note(n.id).body).toBe('two');
    expect(k.note(n.id)).toBe(n);
  });
});

describe('2. every Pin points at a Note that exists', () => {
  it('rejects a pin onto or of a missing Note', () => {
    const { k, desk } = fresh();
    expect(() => k.pin('note_nope', desk.id, 'probe')).toThrow(/no such Note/);
    const n = k.createNote();
    expect(() => k.pin(n.id, 'note_nope', 'probe')).toThrow(/no such Note/);
  });

  it('every live pin resolves', () => {
    const { k, desk } = fresh();
    const n = k.createNote();
    k.pin(n.id, desk.id, 'probe');
    for (const p of k.allPins()) expect(k.hasNote(p.note)).toBe(true);
  });
});

describe('3. at most one Pin is focused', () => {
  it('focusing a second pin blurs the first', () => {
    const { k, desk } = fresh();
    const p1 = k.pin(k.createNote().id, desk.id, 'probe');
    const p2 = k.pin(k.createNote().id, desk.id, 'probe');
    const a = live(k, p1.id);
    const b = live(k, p2.id);
    const blurA = vi.fn();
    a.blur = blurA;
    const focusB = vi.fn();
    b.focus = focusB;

    k.setFocus(p1.id);
    expect(k.focus()).toBe(p1.id);
    k.setFocus(p2.id);
    expect(k.focus()).toBe(p2.id);
    expect(blurA).toHaveBeenCalledOnce();
    expect(focusB).toHaveBeenCalledOnce();
  });
});

describe('4. a keydown goes to the focused Pin only', () => {
  it('routes to the focused pin and nobody else', () => {
    const { k, desk } = fresh();
    const p1 = k.pin(k.createNote().id, desk.id, 'probe');
    const p2 = k.pin(k.createNote().id, desk.id, 'probe');
    const a = live(k, p1.id);
    const b = live(k, p2.id);

    const key = { key: 'x' } as KeyboardEvent;
    k.setFocus(p2.id);
    expect(k.routeKey(key)).toBe(true);
    expect(b.keys).toEqual(['x']);
    expect(a.keys).toEqual([]);
  });

  it('drops the key when nothing is focused', () => {
    const { k, desk } = fresh();
    const p = k.pin(k.createNote().id, desk.id, 'probe');
    const a = live(k, p.id);
    k.setFocus(null);
    expect(k.routeKey({ key: 'x' } as KeyboardEvent)).toBe(false);
    expect(a.keys).toEqual([]);
  });
});

describe('5. if A emits and B subscribes to A, B receives the fact', () => {
  it('delivers, and stops delivering once B is detached', () => {
    const { k, desk } = fresh();
    const noteA = k.createNote('a');
    const noteB = k.createNote('b');
    const pinA = k.pin(noteA.id, desk.id, 'probe');
    const pinB = k.pin(noteB.id, desk.id, 'probe');
    const a = live(k, pinA.id);
    const b = live(k, pinB.id);

    b.host.subscribe(noteA.id);
    a.host.emit('ping', 1);

    expect(b.facts).toEqual([{ from: noteA.id, name: 'ping', data: 1 }]);
    expect(a.facts).toEqual([]);

    k.detach(pinB.id);
    expect(k.spine.subscriberCount(noteA.id)).toBe(0);
  });
});

describe('6 & 7. B reads A only if B holds read:A', () => {
  it('denies, then allows, then denies again', () => {
    const { k, desk } = fresh();
    const noteA = k.createNote('secret');
    const noteB = k.createNote('b');
    k.pin(noteA.id, desk.id, 'probe');
    const pinB = k.pin(noteB.id, desk.id, 'probe');
    const b = live(k, pinB.id);

    expect(() => b.host.read(noteA.id)).toThrow(Denied);

    k.grants.give(pinB.id, readGrant(noteA.id));
    expect(b.host.read(noteA.id)).toBe('secret');

    k.grants.revoke(pinB.id, readGrant(noteA.id));
    expect(() => b.host.read(noteA.id)).toThrow(Denied);
  });

  it('reading self needs no grant', () => {
    const { k, desk } = fresh();
    const n = k.createNote('mine');
    const p = k.pin(n.id, desk.id, 'probe');
    expect(live(k, p.id).host.read(n.id)).toBe('mine');
    expect(k.grants.list(p.id)).toEqual([]);
  });
});

describe('8. a patch to a Note updates every Pin of that Note', () => {
  it('both pins of one Note hear the change', () => {
    const { k, desk } = fresh();
    const shared = k.createNote('before');
    const p1 = k.pin(shared.id, desk.id, 'probe');
    const p2 = k.pin(shared.id, desk.id, 'probe');
    const a = live(k, p1.id);
    const b = live(k, p2.id);

    a.host.write('after');

    expect(k.note(shared.id).body).toBe('after');
    expect(a.patches).toEqual(['after']);
    expect(b.patches).toEqual(['after']);
  });
});

describe('9. a Machine has no DOM', () => {
  class FakeWorker implements WorkerLike {
    toWorker: unknown[] = [];
    private listeners: ((e: { data: unknown }) => void)[] = [];
    constructor(readonly source: string) {}
    postMessage(m: unknown) {
      this.toWorker.push(m);
    }
    terminate() {}
    addEventListener(_t: 'message', fn: (e: { data: unknown }) => void) {
      this.listeners.push(fn);
    }
    fromWorker(data: unknown) {
      for (const l of this.listeners) l({ data });
    }
  }

  it('strips DOM globals in the sandbox preamble', () => {
    expect(SANDBOX_PREAMBLE).toMatch(/self\.document = undefined/);
    expect(SANDBOX_PREAMBLE).toMatch(/self\.window = undefined/);
  });

  it('checks grants on the machine read channel', () => {
    let worker!: FakeWorker;
    const machine = startMachine(
      'onmessage = () => {}',
      ['read:note_x', 'read:note_y'],
      {
        read: (n) => `body of ${n}`,
        emit: () => {},
        holds: (g) => g === 'read:note_x',
      },
      (source) => (worker = new FakeWorker(source)),
    );

    expect(machine.grants).toEqual(['read:note_x']);
    expect(worker.source.startsWith(SANDBOX_PREAMBLE)).toBe(true);

    worker.fromWorker({ req: 'read', id: 1, note: 'note_x' });
    expect(worker.toWorker.at(-1)).toEqual({ id: 1, body: 'body of note_x' });

    worker.fromWorker({ req: 'read', id: 2, note: 'note_y' });
    expect(worker.toWorker.at(-1)).toEqual({ id: 2, error: 'denied: read:note_y' });
  });
});

describe('10. containment has no cycles', () => {
  it('a Note cannot contain itself, directly or at depth', () => {
    const { k, desk } = fresh();
    const a = k.createNote('a');
    const b = k.createNote('b');
    k.pin(a.id, desk.id, 'probe');
    k.pin(b.id, a.id, 'probe');

    expect(() => k.pin(a.id, a.id, 'probe')).toThrow(Cycle);
    expect(() => k.pin(a.id, b.id, 'probe')).toThrow(Cycle);
    expect(() => k.pin(desk.id, b.id, 'probe')).toThrow(Cycle);
    expect(k.contains(desk.id, b.id)).toBe(true);
    expect(k.contains(b.id, a.id)).toBe(false);
  });

  it('the same Note may be pinned in many places without a cycle', () => {
    const { k, desk } = fresh();
    const shared = k.createNote('s');
    const holder = k.createNote('h');
    k.pin(holder.id, desk.id, 'probe');
    k.pin(shared.id, desk.id, 'probe');
    expect(() => k.pin(shared.id, holder.id, 'probe')).not.toThrow();
    expect(k.pinsOf(shared.id)).toHaveLength(2);
  });
});
