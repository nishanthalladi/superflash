import type { Doc, Kernel } from './kernel';

export const DOC_KEY = 'superflash:doc:v3';
export const VIEW_KEY = 'superflash:view:v1';
export const SNAP_KEY = 'superflash:snap';
export const SNAP_KEEP = 5;

/** The slice of localStorage we actually use, so tests can pass a fake. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStore(seed: Record<string, string> = {}): Store {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

export function readDoc(store: Store, key = DOC_KEY): Doc | null {
  const raw = store.getItem(key);
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as Doc;
    // An older document is not worth migrating: the key changes with the version,
    // so an old one is left where it is and the shipped seed boots instead.
    if (doc.version !== 3 || !Array.isArray(doc.notes) || !Array.isArray(doc.pins)) return null;
    return doc;
  } catch {
    return null;
  }
}

/**
 * What the browser keeps: the document minus the repo mirror. `file:` Notes are
 * the repo itself and come back from disk on boot; storing them once per
 * snapshot is what filled localStorage and stopped the app booting.
 */
export function forStore(doc: Doc): Doc {
  const notes = doc.notes.filter((n) => !n.id.startsWith('file:'));
  const keep = new Set(notes.map((n) => n.id));
  const pins = doc.pins.filter((p) => keep.has(p.note) && keep.has(p.parent));
  const pinIds = new Set(pins.map((p) => p.id));
  return {
    ...doc,
    notes,
    pins,
    grants: doc.grants.filter(([pin]) => pinIds.has(pin)),
    modules: doc.modules.filter((m) => keep.has(m)),
    focus: doc.focus && pinIds.has(doc.focus) ? doc.focus : null,
  };
}

/** A full store must never take the app down: the document on disk is the real copy. */
function put(store: Store, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch (err) {
    console.warn('superflash: could not store', key, err);
  }
}

export function writeDoc(store: Store, doc: Doc, key = DOC_KEY): void {
  put(store, key, JSON.stringify(forStore(doc)));
}

/**
 * Keep the last few documents. Cheap insurance today, and the thing a
 * boot-from-Note kernel will need to recover from a bad edit.
 */
export function snapshot(store: Store, doc: Doc): void {
  for (let i = SNAP_KEEP - 1; i > 0; i -= 1) {
    const prev = store.getItem(`${SNAP_KEY}:${i - 1}`);
    if (prev !== null) put(store, `${SNAP_KEY}:${i}`, prev);
  }
  put(store, `${SNAP_KEY}:0`, JSON.stringify(forStore(doc)));
}

export function snapshots(store: Store): Doc[] {
  const out: Doc[] = [];
  for (let i = 0; i < SNAP_KEEP; i += 1) {
    const doc = readDoc(store, `${SNAP_KEY}:${i}`);
    if (doc) out.push(doc);
  }
  return out;
}

/**
 * Save on every kernel change, debounced. Returns a stop function; call
 * `flush()` to force a write (used by tests and `beforeunload`).
 */
export function autosave(
  kernel: Kernel,
  store: Store,
  { delay = 250, timer = globalThis as unknown as typeof globalThis } = {},
): { stop: () => void; flush: () => void } {
  let handle: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (handle !== null) {
      timer.clearTimeout(handle);
      handle = null;
    }
    writeDoc(store, kernel.toJSON());
  };

  const unwatch = kernel.watch(() => {
    if (handle !== null) return;
    handle = timer.setTimeout(() => {
      handle = null;
      writeDoc(store, kernel.toJSON());
    }, delay);
  });

  return {
    stop: () => {
      unwatch();
      if (handle !== null) timer.clearTimeout(handle);
      handle = null;
    },
    flush,
  };
}

/** Where the canvas keeps camera and breadcrumb — view state, not document state. */
export interface View {
  at: string;
  trail: string[];
  cams: Record<string, { x: number; y: number; z: number }>;
}

export function readView(store: Store): View | null {
  const raw = store.getItem(VIEW_KEY);
  if (!raw) return null;
  try {
    const view = JSON.parse(raw) as View;
    return view && typeof view.at === 'string' ? view : null;
  } catch {
    return null;
  }
}

export function writeView(store: Store, view: View): void {
  store.setItem(VIEW_KEY, JSON.stringify(view));
}
