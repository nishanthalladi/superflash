import type { Kernel } from './kernel/kernel';
import type { NoteId } from './kernel/model';
import type { FsClient } from './kernel/type';

/**
 * The repo, as Notes. One Note per text file, and the id *is* the path:
 *
 *   file:src/kernel/kernel.ts
 *
 * No mapping table, no new model field. Edit the Note, the file changes. Edit the
 * file, the Note changes. Disk wins on boot — the app is a view of the repo, not
 * a second copy of it.
 */

export const FILE = 'file:';
export const fileNote = (path: string): NoteId => FILE + path;
export const filePath = (id: NoteId): string | null => (id.startsWith(FILE) ? id.slice(FILE.length) : null);

/** The bridge, over HTTP. `null` where there is no bridge to talk to. */
export function httpFs(base = ''): FsClient {
  const json = async (url: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(base + url, init);
    const value = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(value.error ?? `${res.status} ${url}`);
    return value;
  };
  const post = (url: string, input: unknown): Promise<unknown> =>
    json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });

  return {
    list: () => json('/_fs/list') as ReturnType<FsClient['list']>,
    read: (path) => json(`/_fs/read?path=${encodeURIComponent(path)}`) as ReturnType<FsClient['read']>,
    write: (path, body) => post('/_fs/write', { path, body }) as ReturnType<FsClient['write']>,
    git: (args) => post('/_git', { args }) as ReturnType<FsClient['git']>,
    readDoc: () => json('/_doc') as ReturnType<FsClient['readDoc']>,
    writeDoc: (body) => post('/_doc', { body }) as ReturnType<FsClient['writeDoc']>,
    async ask(prompt, session, onText) {
      const res = await fetch(`${base}/_ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, session }),
      });
      if (!res.ok || !res.body) throw new Error(`${res.status} /_ask`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let done: { session: string; cost: number } | null = null;
      const take = (line: string): void => {
        if (!line.trim()) return;
        const ev = JSON.parse(line) as { text?: string; done?: { session: string; cost: number }; error?: string };
        if (ev.error) throw new Error(ev.error);
        if (ev.text) onText(ev.text);
        if (ev.done) done = ev.done;
      };
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const p of parts) take(p);
      }
      take(buf);
      if (!done) throw new Error('claude gave no result');
      return done;
    },
  };
}

/** Is there a bridge? One request, and a production build answers no. */
export async function reachable(fs: FsClient): Promise<boolean> {
  try {
    await fs.list();
    return true;
  } catch {
    return false;
  }
}

export interface Sync {
  /** Read the repo and bring the Notes in line. */
  pull(): Promise<void>;
  /** Write every Note that is waiting. */
  flush(): Promise<void>;
  stop(): void;
}

export interface SyncOptions {
  /** How often to look for outside edits. */
  every?: number;
  /** How long to wait after a keystroke before writing. */
  delay?: number;
  timer?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;
  onError?: (err: unknown) => void;
}

/**
 * Mirror the repo into the document and back.
 *
 * ponytail: polling for outside edits, not a watcher. Vite already watches the
 * filesystem — push over the HMR socket if a few seconds of lag starts to grate.
 *
 * ponytail: file Notes are saved to localStorage with everything else, so the
 * stored document carries a copy of the repo. Strip them from the saved Doc if
 * that ever hurts; nothing else depends on them being there.
 */
export async function sync(kernel: Kernel, fs: FsClient, options: SyncOptions = {}): Promise<Sync> {
  const { every = 4000, delay = 400, timer = globalThis, onError = (e: unknown) => console.warn('files', e) } = options;
  /** What we believe is on disk, by path. */
  const known = new Map<string, number>();
  const dirty = new Set<string>();
  let writing: Promise<void> = Promise.resolve();
  let handle: ReturnType<typeof setTimeout> | null = null;

  async function pull(): Promise<void> {
    const entries = await fs.list();
    const live = new Set(entries.map((e) => e.path));

    for (const entry of entries) {
      const id = fileNote(entry.path);
      const fresh = known.get(entry.path) !== entry.mtime;
      if (kernel.hasNote(id) && !fresh) continue;
      if (dirty.has(entry.path)) continue; // unsaved keystrokes win over a poll
      const file = await fs.read(entry.path);
      known.set(entry.path, file.mtime);
      if (kernel.hasNote(id)) kernel.patch(id, file.body);
      else kernel.createNote(file.body, id);
    }

    // A file that is gone, and that nothing is looking at, should not linger.
    for (const note of kernel.allNotes()) {
      const path = filePath(note.id);
      if (path === null || live.has(path)) continue;
      known.delete(path);
      if (!kernel.pinsOf(note.id).length) kernel.dropNote(note.id);
    }
  }

  function push(): void {
    const paths = [...dirty];
    dirty.clear();
    writing = writing.then(async () => {
      for (const path of paths) {
        try {
          const { mtime } = await fs.write(path, kernel.body(fileNote(path)));
          known.set(path, mtime);
        } catch (err) {
          onError(err);
        }
      }
    });
  }

  const unwatch = kernel.watch((change) => {
    if (change.kind !== 'patch') return;
    const path = filePath(change.note);
    if (path === null) return;
    dirty.add(path);
    if (handle !== null) return;
    handle = timer.setTimeout(() => {
      handle = null;
      push();
    }, delay);
  });

  await pull();

  const beat = timer.setInterval(() => void pull().catch(onError), every);

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
      handle = null;
    },
  };
}
