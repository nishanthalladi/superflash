import type { Box, NoteId, Pin, PinId } from './model';
import type { Grant } from './grants';

/**
 * Every change the kernel makes, in a form that can be run backwards.
 * Creating a Note is not an op: an unpinned Note is harmless, and dropping it
 * would break any other pin that found it in the meantime.
 */
export type Op =
  | { op: 'patch'; note: NoteId; before: string; after: string }
  | { op: 'pin'; pin: Pin }
  | { op: 'unpin'; pin: Pin; grants: Grant[] }
  | { op: 'move'; pin: PinId; before: Box; after: Box };

/** What the Journal needs from the kernel to run an op backwards. */
export interface Undoable {
  applyInverse(op: Op): void;
}

interface Entry {
  ops: Op[];
  at: number;
  /** Same tag + close in time = one undo step. */
  tag: string;
}

const COALESCE_MS = 400;
const LIMIT = 200;

/**
 * Undo. Lives in the nucleus because every mutation goes through the kernel and
 * nothing else can see them all.
 */
export class Journal {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private open: Entry | null = null;
  private muted = false;
  private now: () => number;

  constructor(private target: Undoable, now: () => number = Date.now) {
    this.now = now;
  }

  record(op: Op, tag: string = op.op): void {
    if (this.muted) return;
    this.future.length = 0;

    if (this.open) {
      this.open.ops.push(op);
      return;
    }

    const last = this.past[this.past.length - 1];
    if (last && last.tag === tag && tag !== '' && this.now() - last.at < COALESCE_MS) {
      const merged = merge(last.ops[last.ops.length - 1], op);
      if (merged) {
        last.ops[last.ops.length - 1] = merged;
        last.at = this.now();
        return;
      }
    }

    this.past.push({ ops: [op], at: this.now(), tag });
    if (this.past.length > LIMIT) this.past.shift();
  }

  /** Group everything done inside `fn` into one undo step. */
  transact<T>(tag: string, fn: () => T): T {
    if (this.open) return fn();
    this.open = { ops: [], at: this.now(), tag: `tx:${tag}` };
    try {
      return fn();
    } finally {
      const entry = this.open;
      this.open = null;
      if (entry.ops.length) {
        this.future.length = 0;
        this.past.push(entry);
        if (this.past.length > LIMIT) this.past.shift();
      }
    }
  }

  undo(): boolean {
    const entry = this.past.pop();
    if (!entry) return false;
    this.run(entry, 'undo');
    this.future.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.future.pop();
    if (!entry) return false;
    this.run(entry, 'redo');
    this.past.push(entry);
    return true;
  }

  get depth(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
    this.open = null;
  }

  private run(entry: Entry, dir: 'undo' | 'redo'): void {
    this.muted = true;
    try {
      const ops = dir === 'undo' ? [...entry.ops].reverse() : entry.ops;
      for (const op of ops) {
        this.target.applyInverse(dir === 'undo' ? op : flip(op));
      }
    } finally {
      this.muted = false;
    }
  }
}

/** The op that undoes the undo. */
function flip(op: Op): Op {
  switch (op.op) {
    case 'patch':
      return { ...op, before: op.after, after: op.before };
    case 'move':
      return { ...op, before: op.after, after: op.before };
    case 'pin':
      return { op: 'unpin', pin: op.pin, grants: [] };
    case 'unpin':
      return { op: 'pin', pin: op.pin };
  }
}

/** Typing in one Note, or dragging one pin, should be a single undo step. */
function merge(prev: Op | undefined, next: Op): Op | null {
  if (!prev) return null;
  if (prev.op === 'patch' && next.op === 'patch' && prev.note === next.note) {
    return { ...prev, after: next.after };
  }
  if (prev.op === 'move' && next.op === 'move' && prev.pin === next.pin) {
    return { ...prev, after: next.after };
  }
  return null;
}
