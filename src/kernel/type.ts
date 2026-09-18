import type { Box, Fact, Note, NoteId, Pin } from './model';
import type { Grant } from './grants';
import type { Machine } from './machine';
// Type-only, so there is no runtime cycle with kernel.ts.
import type { Kernel } from './kernel';

/** One text file in the repo, as the bridge sees it. */
export interface FileEntry {
  path: string;
  size: number;
  mtime: number;
}

/**
 * The repo. Implemented over the dev bridge; `null` in a production build, where
 * there is no bridge to talk to.
 */
export interface FsClient {
  list(): Promise<FileEntry[]>;
  read(path: string): Promise<{ path: string; body: string; mtime: number }>;
  write(path: string, body: string): Promise<{ path: string; mtime: number }>;
  /** An argv array, never a string. */
  git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * One turn with Claude Code in the repo. `onText` gets the reply as it is
   * written; the result comes when it is done. Pass `session` back to keep talking.
   */
  ask(prompt: string, session: string | undefined, onText: (text: string) => void): Promise<{ session: string; cost: number }>;
  /** The live document on disk, so an agent in the repo sees what you see. */
  readDoc(): Promise<{ body: string | null; mtime: number }>;
  writeDoc(body: string): Promise<{ mtime: number }>;
  /**
   * A shell in the repo, started in `cwd` (repo-relative, '' for the root).
   * Output arrives through `onText` as it happens; `onExit` once, when it dies.
   */
  term(
    cwd: string,
    onText: (text: string) => void,
    onExit: (code: number | null) => void,
  ): Promise<{ write(data: string): void; close(): void }>;
}

/** What a Type looks like from the outside once it is registered. */
export interface TypeInfo {
  name: string;
  title: string;
  /** The Note this Type was compiled from, if it came from one. */
  source?: NoteId;
  /** `false` for a tool that ignores its note: it is not a way of looking, so no picker lists it. */
  lens?: boolean;
}

/**
 * What the kernel hands a Type instance. Every capability a Type has is here;
 * there are no other kernel verbs. Anything past read/write self and emit needs
 * a grant.
 */
export interface Host {
  readonly pin: Pin;
  /** Read a Note body. Self is always allowed; anything else needs `read:<id>`. */
  read(note: NoteId): string;
  /** Write this pin's own Note body. */
  write(body: string): void;
  /** Publish a fact from this pin's Note. */
  emit(name: string, data?: unknown): void;
  /** Listen to facts from a Note. */
  subscribe(from: NoteId): void;
  /** Start a worker with a subset of the grants this pin holds. Needs `machine`. */
  startMachine(grants: Grant[]): Machine;
  /** Compile this pin's own Note into a Type and register it. Needs `define`. */
  defineModule(): Promise<TypeInfo>;
  /** Make a Note. Needs `create`. */
  createNote(body?: string): Note;
  /** Place a Note on a parent. Needs `create`. */
  pinNote(note: NoteId, parent: NoteId, type: string, box?: Partial<Box>): Pin;
  /** What Types exist right now. Needs `types`. */
  listTypes(): TypeInfo[];
  /**
   * The kernel itself. Needs `shell`. This is what lets the canvas live in the
   * document instead of in `src/`: it can mount pins, move them, walk
   * containment. Everything a sandboxed Type must not do.
   */
  kernel(): Kernel;
  /**
   * The repo, through the dev bridge. Needs `fs`. Throws when there is no bridge,
   * which is every production build.
   */
  fs(): FsClient;
  grants(): Grant[];
}

export interface TypeInstance {
  /** Draw into this element. The element is sized and positioned by the canvas. */
  mount(box: HTMLElement, note: Note): void;
  focus?(): void;
  blur?(): void;
  /** Write body. Called by the canvas before unmount and on demand. */
  save?(): void;
  /** A fact arrived from a Note this pin subscribes to. */
  onSpine?(fact: Fact): void;
  /** The Note body changed underneath this pin (another pin edited it). */
  onPatch?(note: Note): void;
  /** Keyboard, routed by the canvas to the focused pin only. */
  onKey?(event: KeyboardEvent): void;
  unmount?(): void;
}

export type TypeFactory = (host: Host) => TypeInstance;

export class Registry {
  private types = new Map<string, { factory: TypeFactory; info: TypeInfo }>();
  private watchers = new Set<() => void>();

  define(name: string, factory: TypeFactory, info: Partial<TypeInfo> = {}): TypeInfo {
    const full: TypeInfo = {
      name,
      title: info.title ?? name,
      ...(info.source ? { source: info.source } : {}),
      ...(info.lens === false ? { lens: false } : {}),
    };
    this.types.set(name, { factory, info: full });
    for (const w of [...this.watchers]) w();
    return full;
  }

  get(name: string): TypeFactory {
    const f = this.types.get(name);
    if (!f) throw new Error(`unknown Type: ${name}`);
    return f.factory;
  }

  has(name: string): boolean {
    return this.types.has(name);
  }

  list(): TypeInfo[] {
    return [...this.types.values()].map((t) => t.info);
  }

  /** Fires whenever a Type is defined or redefined. */
  watch(fn: () => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }
}
