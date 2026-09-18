import { Kernel } from '../src/kernel/kernel';
import { CREATE, FS, SHELL, TYPES } from '../src/kernel/grants';
import type { NoteId, PinId } from '../src/kernel/model';
import { loadSource } from '../src/kernel/modules';
import type { TypeFactory, TypeInstance } from '../src/kernel/type';
import type { FsClient } from '../src/kernel/type';
import canvasJs from '../seed/canvas.js?raw';
import treeJs from '../seed/tree.js?raw';
import gitPanelJs from '../seed/git-panel.js?raw';
import splitJs from '../seed/split.js?raw';
import textJs from '../seed/text.js?raw';
import chatJs from '../seed/chat.js?raw';
import imageJs from '../seed/image.js?raw';

/**
 * The canvas and the tools are seed Notes, so tests compile them the same way the
 * app does. If a seed file stops being a valid module, every test that touches the
 * UI fails — which is the point.
 */
const factory = async (source: string): Promise<TypeFactory> =>
  ((await loadSource(source))['default'] as TypeFactory);

export const canvas = await factory(canvasJs);
export const tree = await factory(treeJs);
export const gitPanel = await factory(gitPanelJs);
export const split = await factory(splitJs);
export const text = await factory(textJs);
export const chat = await factory(chatJs);
export const image = await factory(imageJs);

/** A Type with no powers and no chrome, for tests that only need something drawn. */
export const plain: TypeFactory = (host) => {
  let area: HTMLTextAreaElement;
  return {
    mount(el, note) {
      area = document.createElement('textarea');
      area.className = 'plain';
      area.value = note.body;
      area.addEventListener('input', () => host.write(area.value));
      el.append(area);
    },
    focus() {
      area.focus();
    },
    onPatch(note) {
      if (area.value !== note.body) area.value = note.body;
    },
  };
};

/**
 * A repo in a Map. Every mtime is a counter, so "changed" is never ambiguous, and
 * `git` echoes its argv so a test can prove no shell was involved.
 */
export function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const mtimes = new Map([...files.keys()].map((p) => [p, 1]));
  const writes: string[] = [];
  const ran: string[][] = [];
  const asked: { prompt: string; session?: string }[] = [];
  const media: { name: string; type: string; base64: string }[] = [];
  let docFile: string | null = null;
  let docMtime = 0;
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
    async readDoc() {
      return { body: docFile, mtime: docMtime };
    },
    async writeDoc(body) {
      docFile = body;
      docMtime += 1;
      return { mtime: docMtime };
    },
    async media(name, type, base64) {
      media.push({ name, type, base64 });
      return { path: `media/${name}` };
    },
    async ask(prompt, session, onText) {
      asked.push({ prompt, session });
      for (const piece of ['echo: ', prompt]) onText(piece);
      return { session: session ?? 'sess-1', cost: 0.01 };
    },
  };

  /** Somebody edited the file outside the app. */
  const outside = (path: string, body: string): void => {
    files.set(path, body);
    clock += 1;
    mtimes.set(path, clock);
  };

  /** Somebody (an agent) edited the document on disk. */
  const outsideDoc = (body: string): void => {
    docFile = body;
    docMtime += 1;
  };

  return { fs, files, outside, outsideDoc, doc: () => docFile, writes, ran, asked, media };
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

/** Run a box (Shift+Enter) and wait for it to settle. Returns the output text. */
export async function runBox(el: ParentNode): Promise<string> {
  const text = el.querySelector<HTMLTextAreaElement>('.text-body')!;
  const out = el.querySelector<HTMLElement>('.text-out')!;
  text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  await until(() => out.textContent !== '…');
  return out.textContent ?? '';
}

export interface Mounted {
  instance: TypeInstance & {
    noteId: NoteId;
    viewAs: string;
    enter(note: NoteId): void;
    leave(): void;
    setView(type: string): void;
  };
  pin: PinId;
}

/**
 * Mount the canvas on `note` the way `stage0` does: one pin on the root Note,
 * holding `shell`.
 */
export function mountCanvas(kernel: Kernel, root: HTMLElement, note: NoteId): Mounted {
  // The canvas stores its camera in localStorage, which jsdom shares across tests.
  try {
    localStorage.clear();
  } catch {
    // no store, no camera
  }
  if (!kernel.types.has('canvas')) kernel.types.define('canvas', canvas, { title: 'Canvas' });
  if (!kernel.types.has('text')) kernel.types.define('text', text, { title: 'Text' });
  // Every canvas gets the same powers, at every depth — as the policy does.
  const powers = (id: PinId): void => kernel.grants.give(id, SHELL, CREATE, TYPES);
  for (const p of kernel.allPins()) if (p.type === 'canvas' || p.type === 'text') powers(p.id);
  kernel.watch((c) => {
    if (c.kind === 'pin:add' && kernel.hasPin(c.pin) && ['canvas', 'text'].includes(kernel.getPin(c.pin).type)) powers(c.pin);
  });
  const shell = kernel.createNote('root');
  kernel.root = shell.id;
  const pin = kernel.pin(note, shell.id, 'canvas');
  powers(pin.id);
  const instance = kernel.types.get('canvas')(kernel.host(pin.id)) as Mounted['instance'];
  kernel.attach(pin.id, instance);
  instance.mount(root, kernel.note(note));
  return { instance, pin: pin.id };
}

/** Mount one Type on a scratch Note, with the grants the policy would give it. */
export function mountOne(
  kernel: Kernel,
  root: HTMLElement,
  name: string,
  factory: TypeFactory,
  grants: string[] = [FS],
): { pin: PinId; instance: TypeInstance } {
  if (!kernel.types.has(name)) kernel.types.define(name, factory, { title: name });
  const parent = kernel.createNote('parent');
  const pin = kernel.pin(kernel.createNote('').id, parent.id, name);
  kernel.grants.give(pin.id, ...grants);
  const instance = kernel.types.get(name)(kernel.host(pin.id));
  kernel.attach(pin.id, instance);
  instance.mount(root, kernel.note(pin.note));
  return { pin: pin.id, instance };
}
