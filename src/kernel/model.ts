export type NoteId = string;
export type PinId = string;

/** A Note: one id, one body. Always a canvas — it can hold other Notes via Pins. */
export interface Note {
  id: NoteId;
  body: string;
}

/** One placement of a Note on a parent Note. */
export interface Pin {
  id: PinId;
  /** The Note whose body this pin shows. */
  note: NoteId;
  /** The Note this pin sits on. */
  parent: NoteId;
  /** Which Type draws this pin. */
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A fact on the Spine. Small data only. */
export interface Fact {
  from: NoteId;
  name: string;
  data?: unknown;
}

let n = 0;

/** `note_3f_x9k2` — the middle field is a monotonic counter, so ids sort by age. */
export function newId(prefix: string): string {
  n += 1;
  return `${prefix}_${n.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * After loading a document, push the counter past every id it contains so a new
 * id can never collide with a stored one.
 */
export function seedIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const parts = id.split('_');
    if (parts.length < 3) continue;
    const seen = parseInt(parts[1]!, 36);
    if (Number.isFinite(seen) && seen > n) n = seen;
  }
}
