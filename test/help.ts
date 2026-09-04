import { Kernel } from '../src/kernel/kernel';
import { CREATE, SHELL, TYPES } from '../src/kernel/grants';
import type { NoteId, PinId } from '../src/kernel/model';
import { loadSource } from '../src/kernel/modules';
import type { TypeFactory, TypeInstance } from '../src/kernel/type';
import type { FsClient } from '../src/kernel/type';
import deskJs from '../seed/desk.js?raw';
import stubJs from '../seed/stub.js?raw';
import paletteJs from '../seed/palette.js?raw';
import treeJs from '../seed/tree.js?raw';
import gitPanelJs from '../seed/git-panel.js?raw';

/**
 * The Desk, the Stub and the palette are seed Notes now, so tests compile them
 * the same way the app does. If a seed file stops being a valid module, every
 * test that touches the UI fails — which is the point.
 */
const factory = async (source: string): Promise<TypeFactory> =>
  ((await loadSource(source))['default'] as TypeFactory);

export const stub = await factory(stubJs);
export const desk = await factory(deskJs);
export const palette = await factory(paletteJs);
export const tree = await factory(treeJs);
export const gitPanel = await factory(gitPanelJs);

/**
 * A repo in a Map. Every mtime is a counter, so "changed" is never ambiguous, and
 * `git` echoes its argv so a test can prove no shell was involved.
 */
export function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const mtimes = new Map([...files.keys()].map((p) => [p, 1]));
  const writes: string[] = [];
  const ran: string[][] = [];
  let clock = 1;

  const fs: FsClient = {
    async list() {
      return [...files].map(([path, body]) => ({ path, size: body.length, mtime: mtimes.get(path) ?? 0 }));
    },
    async read(path) {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return { path, body: files.get(path)!, mtime: mtimes.get(path) ?? 0 };
    },
    async write(path, body) {
      writes.push(path);
      files.set(path, body);
      clock += 1;
      mtimes.set(path, clock);
      return { path, mtime: clock };
    },
    async git(args) {
      ran.push(args);
      if (args[0] === 'status') return { code: 0, stdout: ' M src/a.ts\n?? new.ts\n', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      return { code: 0, stdout: args.join(' '), stderr: '' };
    },
  };

  /** Somebody edited the file outside the app. */
  const outside = (path: string, body: string): void => {
    files.set(path, body);
    clock += 1;
    mtimes.set(path, clock);
  };

  return { fs, files, outside, writes, ran };
}

/**
 * Wait for a condition instead of guessing how many microtasks a data-URL import
 * takes. Cells run real modules, so the number is not knowable.
 */
export async function until(what: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (what()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('condition never became true');
}

/** Click a Cell's run button and wait for it to settle. Returns the output text. */
export async function runCell(box: ParentNode): Promise<string> {
  box.querySelector<HTMLButtonElement>('.cell-tools button')!.click();
  const status = box.querySelector<HTMLElement>('.cell-status')!;
  await until(() => status.textContent !== 'running…');
  return box.querySelector<HTMLElement>('.cell-out')!.textContent ?? '';
}

export interface Mounted {
  instance: TypeInstance & { noteId: NoteId; armed: string; open(note: NoteId): void };
  pin: PinId;
}

/**
 * Mount the Desk on `note` the way `stage0` does: one pin on the root Note,
 * holding `shell`.
 */
export function mountDesk(kernel: Kernel, root: HTMLElement, note: NoteId): Mounted {
  // The Desk stores its camera in localStorage, which jsdom shares across tests.
  try {
    localStorage.clear();
  } catch {
    // no store, no camera
  }
  if (!kernel.types.has('desk')) kernel.types.define('desk', desk, { title: 'Desk' });
  const shell = kernel.createNote('shell');
  kernel.root = shell.id;
  const pin = kernel.pin(note, shell.id, 'desk');
  kernel.grants.give(pin.id, SHELL, CREATE, TYPES);
  const instance = kernel.types.get('desk')(kernel.host(pin.id)) as Mounted['instance'];
  kernel.attach(pin.id, instance);
  instance.mount(root, kernel.note(note));
  return { instance, pin: pin.id };
}
