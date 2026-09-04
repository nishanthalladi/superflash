import { newId, seedIds } from './model';
import type { Box, Fact, Note, NoteId, Pin, PinId } from './model';
import { CREATE, DEFINE, Denied, FS, Grants, MACHINE, SHELL, TYPES, readGrant } from './grants';
import type { Grant } from './grants';
import { Spine } from './spine';
import { Registry } from './type';
import type { FsClient, Host, TypeInfo, TypeInstance } from './type';
import { startMachine } from './machine';
import type { Machine } from './machine';
import { Journal } from './journal';
import type { Op, Undoable } from './journal';
import { defineModule } from './modules';
import type { Loader } from './modules';

export type Change =
  | { kind: 'patch'; note: NoteId }
  | { kind: 'pin:add'; pin: PinId }
  | { kind: 'pin:remove'; pin: PinId; parent: NoteId }
  | { kind: 'pin:move'; pin: PinId }
  | { kind: 'focus'; pin: PinId | null }
  | { kind: 'doc'; note?: NoteId };

/** The serialized document. Everything a reload needs; nothing about the view. */
export interface Doc {
  /** 2 dropped `chrome`: what is always on screen is a `split` Type now. */
  version: 2;
  root: NoteId;
  notes: Note[];
  pins: Pin[];
  focus: PinId | null;
  grants: [PinId, Grant[]][];
  /** Notes that are Types. Registered before the Desk renders. */
  modules: NoteId[];
}

export class Cycle extends Error {
  constructor(note: NoteId, parent: NoteId) {
    super(`cycle: ${note} would contain itself via ${parent}`);
    this.name = 'Cycle';
  }
}

interface Runtime {
  instance: TypeInstance;
  unsubs: (() => void)[];
  machines: Machine[];
}

/**
 * The nucleus. It knows Notes, Pins, containment, focus, the Spine, grants,
 * modules and how to serialize itself. It knows nothing about drawing,
 * scrolling, formulas or tools — those live in Types, and it never imports one.
 */
export class Kernel implements Undoable {
  readonly spine = new Spine();
  readonly grants = new Grants();
  readonly types = new Registry();
  readonly journal = new Journal(this);

  /** The Note everything else sits on. */
  root: NoteId = '';
  /** Notes that compile to Types. */
  readonly modules = new Set<NoteId>();
  /**
   * The repo, when there is a bridge to reach it through. Set by `stage0`; the
   * kernel only holds it so `host.fs()` can hand it out behind a grant.
   */
  fs: FsClient | null = null;

  private notes = new Map<NoteId, Note>();
  private pins = new Map<PinId, Pin>();
  private runtimes = new Map<PinId, Runtime>();
  private focused: PinId | null = null;
  private watchers = new Set<(c: Change) => void>();

  // --- notes ---------------------------------------------------------------

  /**
   * `id` is for Notes whose identity comes from somewhere else — a file Note is
   * `file:<path>`, so the path *is* the id and no mapping table exists.
   */
  createNote(body = '', id?: NoteId): Note {
    if (id !== undefined && this.notes.has(id)) throw new Error(`Note already exists: ${id}`);
    const note: Note = { id: id ?? newId('note'), body };
    this.notes.set(note.id, note);
    return note;
  }

  /** Drop a Note. Refuses while anything still pins it. */
  dropNote(id: NoteId): void {
    if (this.pinsOf(id).length) throw new Error(`Note is still pinned: ${id}`);
    this.notes.delete(id);
    this.modules.delete(id);
    this.announce({ kind: 'doc', note: id });
  }

  note(id: NoteId): Note {
    const n = this.notes.get(id);
    if (!n) throw new Error(`no such Note: ${id}`);
    return n;
  }

  body(id: NoteId): string {
    return this.note(id).body;
  }

  hasNote(id: NoteId): boolean {
    return this.notes.has(id);
  }

  allNotes(): Note[] {
    return [...this.notes.values()];
  }

  /** Rule 2: edit once, every pin shows it. */
  patch(id: NoteId, body: string): void {
    const note = this.note(id);
    if (note.body === body) return;
    this.journal.record({ op: 'patch', note: id, before: note.body, after: body }, `patch:${id}`);
    note.body = body;
    for (const pin of this.pinsOf(id)) {
      this.runtimes.get(pin.id)?.instance.onPatch?.(note);
    }
    this.announce({ kind: 'patch', note: id });
  }

  // --- pins ----------------------------------------------------------------

  pin(note: NoteId, parent: NoteId, type: string, box: Partial<Box> = {}): Pin {
    if (!this.hasNote(note)) throw new Error(`no such Note: ${note}`);
    if (!this.hasNote(parent)) throw new Error(`no such Note: ${parent}`);
    if (note === parent || this.contains(note, parent)) throw new Cycle(note, parent);
    if (!this.types.has(type)) throw new Error(`unknown Type: ${type}`);
    const p: Pin = {
      id: newId('pin'),
      note,
      parent,
      type,
      x: box.x ?? 0,
      y: box.y ?? 0,
      width: box.width ?? 240,
      height: box.height ?? 160,
    };
    this.pins.set(p.id, p);
    this.journal.record({ op: 'pin', pin: { ...p } });
    this.announce({ kind: 'pin:add', pin: p.id });
    return p;
  }

  getPin(id: PinId): Pin {
    const p = this.pins.get(id);
    if (!p) throw new Error(`no such Pin: ${id}`);
    return p;
  }

  hasPin(id: PinId): boolean {
    return this.pins.has(id);
  }

  unpin(id: PinId): void {
    const pin = this.getPin(id);
    this.journal.record({ op: 'unpin', pin: { ...pin }, grants: this.grants.list(id) });
    this.detach(id);
    this.grants.drop(id);
    this.pins.delete(id);
    if (this.focused === id) this.setFocus(null);
    this.announce({ kind: 'pin:remove', pin: id, parent: pin.parent });
  }

  move(id: PinId, box: Partial<Box>): void {
    const pin = this.getPin(id);
    const before: Box = { x: pin.x, y: pin.y, width: pin.width, height: pin.height };
    Object.assign(pin, box);
    const after: Box = { x: pin.x, y: pin.y, width: pin.width, height: pin.height };
    if (same(before, after)) return;
    this.journal.record({ op: 'move', pin: id, before, after }, `move:${id}`);
    this.announce({ kind: 'pin:move', pin: id });
  }

  /** Pins sitting on this Note. */
  childPins(parent: NoteId): Pin[] {
    return [...this.pins.values()].filter((p) => p.parent === parent);
  }

  /** Every placement of this Note. */
  pinsOf(note: NoteId): Pin[] {
    return [...this.pins.values()].filter((p) => p.note === note);
  }

  /** Every pin drawn by this Type. */
  pinsOfType(type: string): Pin[] {
    return [...this.pins.values()].filter((p) => p.type === type);
  }

  allPins(): Pin[] {
    return [...this.pins.values()];
  }

  /** Does `outer` contain `inner`, at any depth? */
  contains(outer: NoteId, inner: NoteId): boolean {
    const seen = new Set<NoteId>();
    const stack = [outer];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of this.childPins(cur)) {
        if (p.note === inner) return true;
        stack.push(p.note);
      }
    }
    return false;
  }

  // --- focus ---------------------------------------------------------------

  /** Rule 3: only one pin is focused. */
  setFocus(id: PinId | null): void {
    if (this.focused === id) return;
    const before = this.focused;
    if (before) this.runtimes.get(before)?.instance.blur?.();
    this.focused = id;
    if (id) {
      this.getPin(id);
      this.runtimes.get(id)?.instance.focus?.();
    }
    this.announce({ kind: 'focus', pin: id });
  }

  focus(): PinId | null {
    return this.focused;
  }

  /** Rule 4: keyboard input goes to the focused pin only. */
  routeKey(event: KeyboardEvent): boolean {
    if (!this.focused) return false;
    const rt = this.runtimes.get(this.focused);
    if (!rt?.instance.onKey) return false;
    rt.instance.onKey(event);
    return true;
  }

  // --- modules -------------------------------------------------------------

  /**
   * Compile a Note into a Type. On failure the old Type stays registered and the
   * Note stays marked as a module, so you can fix it and run it again.
   */
  async defineModule(note: NoteId, load?: Loader): Promise<TypeInfo> {
    const info = await defineModule({ body: (n) => this.body(n), types: this.types }, note, load);
    this.modules.add(note);
    this.announce({ kind: 'doc', note });
    return info;
  }

  /** Re-register every module Note. Returns whatever failed, so boot can go on. */
  async loadModules(load?: Loader): Promise<{ ok: TypeInfo[]; failed: { note: NoteId; error: unknown }[] }> {
    const ok: TypeInfo[] = [];
    const failed: { note: NoteId; error: unknown }[] = [];
    for (const note of this.modules) {
      try {
        ok.push(await this.defineModule(note, load));
      } catch (error) {
        failed.push({ note, error });
      }
    }
    return { ok, failed };
  }

  // --- undo ----------------------------------------------------------------

  /** Run one op backwards. The Journal mutes itself while this happens. */
  applyInverse(op: Op): void {
    switch (op.op) {
      case 'patch':
        if (this.hasNote(op.note)) this.patch(op.note, op.before);
        return;
      case 'move':
        if (this.hasPin(op.pin)) this.move(op.pin, op.before);
        return;
      case 'pin':
        if (this.hasPin(op.pin.id)) this.unpin(op.pin.id);
        return;
      case 'unpin':
        this.restorePin(op.pin, op.grants);
        return;
    }
  }

  /** Put a pin back exactly as it was, id and all. Undo depends on this. */
  restorePin(pin: Pin, grants: Grant[] = []): void {
    if (!this.hasNote(pin.note) || !this.hasNote(pin.parent)) return;
    if (this.pins.has(pin.id)) return;
    this.pins.set(pin.id, { ...pin });
    if (grants.length) this.grants.give(pin.id, ...grants);
    this.announce({ kind: 'pin:add', pin: pin.id });
  }

  // --- document ------------------------------------------------------------

  toJSON(): Doc {
    return {
      version: 2,
      root: this.root,
      notes: this.allNotes().map((n) => ({ ...n })),
      pins: this.allPins().map((p) => ({ ...p })),
      focus: this.focused,
      grants: this.allPins()
        .map((p) => [p.id, this.grants.list(p.id)] as [PinId, Grant[]])
        .filter(([, g]) => g.length > 0),
      modules: [...this.modules],
    };
  }

  /**
   * Replace everything with a stored document. Modules are only *marked* here —
   * call `loadModules()` next, then render.
   */
  load(doc: Doc): void {
    for (const id of [...this.runtimes.keys()]) this.detach(id);
    this.notes.clear();
    this.pins.clear();
    this.modules.clear();
    this.focused = null;
    this.journal.clear();

    for (const n of doc.notes) this.notes.set(n.id, { ...n });
    for (const p of doc.pins) {
      if (this.notes.has(p.note) && this.notes.has(p.parent)) this.pins.set(p.id, { ...p });
    }
    for (const [pin, grants] of doc.grants) {
      if (this.pins.has(pin)) this.grants.give(pin, ...grants);
    }
    for (const m of doc.modules) if (this.notes.has(m)) this.modules.add(m);

    this.root = this.notes.has(doc.root) ? doc.root : (doc.notes[0]?.id ?? '');
    this.focused = doc.focus && this.pins.has(doc.focus) ? doc.focus : null;

    seedIds([...this.notes.keys(), ...this.pins.keys()]);
    this.announce({ kind: 'doc' });
  }

  // --- type instances ------------------------------------------------------

  /** Build the Host a Type instance gets. */
  host(pinId: PinId): Host {
    const kernel = this;
    const pin = this.getPin(pinId);
    const need = (grant: Grant): void => {
      if (!kernel.grants.has(pinId, grant)) throw new Denied(grant);
    };
    return {
      pin,
      read(note) {
        if (note !== pin.note && !kernel.grants.has(pinId, readGrant(note))) {
          throw new Denied(readGrant(note));
        }
        return kernel.body(note);
      },
      write(body) {
        kernel.patch(pin.note, body);
      },
      emit(name, data) {
        kernel.spine.emit(pin.note, name, data);
      },
      subscribe(from) {
        const unsub = kernel.spine.subscribe(from, (fact: Fact) => {
          kernel.runtimes.get(pinId)?.instance.onSpine?.(fact);
        });
        kernel.runtimes.get(pinId)?.unsubs.push(unsub);
      },
      startMachine(grants: Grant[]) {
        need(MACHINE);
        const machine = startMachine(kernel.body(pin.note), grants, {
          read: (note) => kernel.body(note),
          emit: (name, data) => kernel.spine.emit(pin.note, name, data),
          holds: (g) => kernel.grants.has(pinId, g),
        });
        kernel.runtimes.get(pinId)?.machines.push(machine);
        return machine;
      },
      async defineModule() {
        need(DEFINE);
        return kernel.defineModule(pin.note);
      },
      createNote(body) {
        need(CREATE);
        return kernel.createNote(body);
      },
      pinNote(note, parent, type, box) {
        need(CREATE);
        return kernel.pin(note, parent, type, box);
      },
      listTypes() {
        need(TYPES);
        return kernel.types.list();
      },
      kernel() {
        need(SHELL);
        return kernel;
      },
      fs() {
        need(FS);
        if (!kernel.fs) throw new Error('no bridge: the repo is only reachable in dev');
        return kernel.fs;
      },
      grants() {
        return kernel.grants.list(pinId);
      },
    };
  }

  /** Register a live Type instance for a pin. The Desk owns the element. */
  attach(pinId: PinId, instance: TypeInstance): void {
    this.detach(pinId);
    this.runtimes.set(pinId, { instance, unsubs: [], machines: [] });
  }

  detach(pinId: PinId): void {
    const rt = this.runtimes.get(pinId);
    if (!rt) return;
    try {
      rt.instance.save?.();
      rt.instance.unmount?.();
    } catch {
      // A misbehaving Type must not block teardown.
    }
    for (const u of rt.unsubs) u();
    for (const m of rt.machines) m.stop();
    this.runtimes.delete(pinId);
  }

  instance(pinId: PinId): TypeInstance | undefined {
    return this.runtimes.get(pinId)?.instance;
  }

  // --- change notification -------------------------------------------------

  watch(fn: (c: Change) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  private announce(c: Change): void {
    for (const w of [...this.watchers]) w(c);
  }
}

function same(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
