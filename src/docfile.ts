import type { Doc, Kernel } from './kernel/kernel';
import type { FsClient } from './kernel/type';
import { filePath } from './files';

/**
 * The document, on disk. `.superflash/doc.json` is the same JSON the browser
 * keeps in localStorage — written after every change, read back when something
 * else changes it. That something else is the agent: a Claude in the repo can
 * make a box, move one, or write in one by editing this file, with the tools it
 * already has. Disk wins on boot, as it does for every other file.
 *
 * `file:` Notes are left out: they *are* the repo, and the agent has the repo.
 */

/** What goes to disk: the document, minus the repo mirror. */
export function forDisk(doc: Doc): Doc {
  const notes = doc.notes.filter((n) => filePath(n.id) === null);
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

/**
 * Bring the live kernel in line with a document from outside, without tearing
 * anything down: patch bodies, add and move and remove pins. Mounted Types see
 * ordinary changes, and every one of them is undoable.
 *
 * ponytail: notes and pins only. Grants and modules stay as booted; an agent that
 * wants a new Type writes a file and pins it.
 */
export function applyDoc(kernel: Kernel, doc: Doc): void {
  kernel.journal.transact('outside', () => {
    const notes = new Set<string>();
    for (const n of doc.notes) {
      notes.add(n.id);
      if (!kernel.hasNote(n.id)) kernel.createNote(n.body, n.id);
      else if (kernel.body(n.id) !== n.body) kernel.patch(n.id, n.body);
    }
    const pins = new Map(doc.pins.map((p) => [p.id, p]));
    for (const p of kernel.allPins()) {
      if (filePath(p.note) !== null) continue; // the mirror is not in the file
      if (!pins.has(p.id)) kernel.unpin(p.id);
    }
    for (const p of pins.values()) {
      if (!kernel.hasNote(p.note) || !kernel.hasNote(p.parent) || !kernel.types.has(p.type)) continue;
      if (!kernel.hasPin(p.id)) {
        // The file chose the id, so `pin()` (which mints one) will not do.
        kernel.restorePin(p);
        kernel.journal.record({ op: 'pin', pin: { ...p } });
        continue;
      }
      const live = kernel.getPin(p.id);
      if (live.x !== p.x || live.y !== p.y || live.width !== p.width || live.height !== p.height) {
        kernel.move(p.id, { x: p.x, y: p.y, width: p.width, height: p.height });
      }
    }
    // A note the file dropped, that nothing pins any more, goes too.
    for (const n of kernel.allNotes()) {
      if (filePath(n.id) !== null || notes.has(n.id) || n.id === kernel.root) continue;
      if (!kernel.pinsOf(n.id).length) kernel.dropNote(n.id);
    }
  });
}

export interface DocSync {
  flush(): Promise<void>;
  pull(): Promise<void>;
  stop(): void;
}

export interface DocSyncOptions {
  every?: number;
  delay?: number;
  timer?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;
  onError?: (err: unknown) => void;
}

/** Keep `.superflash/doc.json` and the kernel the same, both ways. */
export function syncDoc(kernel: Kernel, fs: FsClient, options: DocSyncOptions = {}): DocSync {
  const { every = 2000, delay = 400, timer = globalThis, onError = (e: unknown) => console.warn('doc', e) } = options;
  let known = 0; // the mtime of what we last wrote or read
  let last = ''; // its text, to skip our own echo
  let handle: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const push = (): void => {
    const text = `${JSON.stringify(forDisk(kernel.toJSON()), null, 2)}\n`;
    if (text === last) return;
    last = text;
    writing = writing
      .then(async () => {
        known = (await fs.writeDoc(text)).mtime;
      })
      .catch(onError);
  };

  async function pull(): Promise<void> {
    const file = await fs.readDoc();
    if (file.body === null || file.mtime === known || file.body === last) return;
    known = file.mtime;
    last = file.body;
    let doc: Doc;
    try {
      doc = JSON.parse(file.body) as Doc;
    } catch (err) {
      onError(err);
      return;
    }
    applyDoc(kernel, doc);
  }

  const unwatch = kernel.watch(() => {
    if (handle !== null) return;
    handle = timer.setTimeout(() => {
      handle = null;
      push();
    }, delay);
  });
  const beat = timer.setInterval(() => void pull(), every);

  return {
    pull,
    async flush() {
      if (handle !== null) {
        timer.clearTimeout(handle);
        handle = null;
      }
      push();
      await writing;
    },
    stop() {
      unwatch();
      timer.clearInterval(beat);
      if (handle !== null) timer.clearTimeout(handle);
    },
  };
}
