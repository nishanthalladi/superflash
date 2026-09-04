import type { NoteId, PinId } from './model';

/** A grant string, e.g. `read:note_1` or `write:note_1`. */
export type Grant = string;

export const readGrant = (note: NoteId): Grant => `read:${note}`;
export const writeGrant = (note: NoteId): Grant => `write:${note}`;

/** Capability grants: powers that are not about one particular Note. */
export const DEFINE: Grant = 'define';
export const CREATE: Grant = 'create';
export const TYPES: Grant = 'types';
export const MACHINE: Grant = 'machine';
/**
 * The whole kernel. Only the app's own furniture holds this — the Desk, which
 * has to mount pins, and a Cell, which is a console for editing the app from
 * inside itself. A Type written in the app gets it only if policy says so.
 *
 * ponytail: one grant instead of a verb per kernel method. Narrow it into
 * individual verbs (mountPin, move, unpin, …) the day an untrusted Type needs
 * one of them.
 */
export const SHELL: Grant = 'shell';
/**
 * The repo, through the dev bridge: list, read, write, git.
 *
 * This one is ergonomics and an audit trail, not a sandbox. A Type runs in the
 * page and the page has `fetch`, so anything on the desk could reach the bridge
 * on its own. What actually stops that is the bridge itself — path-jailed, and
 * absent from a production build. A Type that must be contained needs a Machine.
 */
export const FS: Grant = 'fs';

export class Denied extends Error {
  constructor(public grant: Grant) {
    super(`denied: ${grant}`);
    this.name = 'Denied';
  }
}

/**
 * Grants held per pin. Default grants (read/write self, emit) are implicit and
 * live in Kernel, which knows which Note a pin belongs to. Everything else is
 * denied until granted.
 */
export class Grants {
  private held = new Map<PinId, Set<Grant>>();

  give(pin: PinId, ...grants: Grant[]): void {
    let set = this.held.get(pin);
    if (!set) {
      set = new Set();
      this.held.set(pin, set);
    }
    for (const g of grants) set.add(g);
  }

  revoke(pin: PinId, ...grants: Grant[]): void {
    const set = this.held.get(pin);
    if (!set) return;
    for (const g of grants) set.delete(g);
  }

  has(pin: PinId, grant: Grant): boolean {
    return this.held.get(pin)?.has(grant) ?? false;
  }

  list(pin: PinId): Grant[] {
    return [...(this.held.get(pin) ?? [])];
  }

  drop(pin: PinId): void {
    this.held.delete(pin);
  }
}
