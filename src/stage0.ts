import { Kernel } from './kernel/kernel';
import type { Doc } from './kernel/kernel';
import { CREATE, DEFINE, FS, MACHINE, SHELL, TYPES } from './kernel/grants';
import type { Grant } from './kernel/grants';
import type { Pin, PinId } from './kernel/model';
import { autosave, readDoc, snapshot } from './kernel/persist';
import type { Store } from './kernel/persist';
import { code } from './types/code';
import type { FsClient } from './kernel/type';
import { httpFs, reachable, sync } from './files';
import type { Sync } from './files';
import { FILES, pointer, resolve, seedDoc } from './seed';
import { loadSource } from './kernel/modules';
import { safeShell } from './safe';
import { syncDoc } from './docfile';
import type { DocSync } from './docfile';

/**
 * Grant policy: which powers a pin gets purely from its Type.
 *
 * This is the trust root, so it stays in `src/` — the thing being governed must
 * not be able to edit it. A Type written inside the app is not in this table and
 * gets nothing beyond read/write self and emit.
 */
export const POLICY: Record<string, Grant[]> = {
  // One Type does everything a canvas does, at every depth — so it holds
  // everything a canvas needs, including running what you type in it.
  canvas: [SHELL, FS, DEFINE, CREATE, TYPES, MACHINE],
  // A text box runs what you type in it, so it holds the same.
  text: [SHELL, FS, DEFINE, CREATE, TYPES, MACHINE],
  chat: [FS],
  split: [SHELL],
  code: [DEFINE],
  tree: [FS],
  'git-panel': [FS],
  terminal: [FS],
};

export function applyPolicy(kernel: Kernel, pin: Pin): void {
  const grants = POLICY[pin.type];
  if (grants) kernel.grants.give(pin.id, ...grants);
}

/** The only Type in `src/`: a file editor. Enough to repair a broken canvas. */
export function registerBuiltins(kernel: Kernel): void {
  kernel.types.define('code', code, { title: 'Code', lens: false });
}

export interface Booted {
  kernel: Kernel;
  save: { stop: () => void; flush: () => void };
  /** The single pin on the root Note, if the shell mounted. */
  shell: PinId | null;
  /** The repo mirror, when there is a bridge. */
  files: Sync | null;
  /** The document on disk, when there is a bridge. */
  doc: DocSync | null;
}

export interface Stage0Options {
  /** Ignore what is stored and boot the shipped seed. */
  fresh?: boolean;
  /** Skip module compilation and go straight to the safe shell. */
  safe?: boolean;
  /**
   * The repo. Pass `null` to boot without one; leave it out and stage0 probes the
   * dev bridge, which a production build does not have.
   */
  fs?: FsClient | null;
}

/**
 * Boot order: load the document, compile its modules, then mount the one pin on
 * the root Note (rule 6 — one pin means that Type fills the screen). That pin is
 * the canvas, and the canvas is a Note like everything else.
 */
export async function stage0(root: HTMLElement, store: Store, options: Stage0Options = {}): Promise<Booted> {
  const kernel = new Kernel();
  const live = (file: string): string | undefined =>
    kernel.hasNote(`file:seed/${file}`) ? kernel.body(`file:seed/${file}`) : undefined;
  kernel.loader = (source) => loadSource(resolve(source, live));
  registerBuiltins(kernel);

  const stored = options.fresh ? null : readDoc(store);
  if (stored) snapshot(store, stored);
  kernel.load(stored ?? seedDoc());

  // Disk wins for the document too: if the repo has one, it is what you see.
  const client = options.fs === undefined ? httpFs() : options.fs;
  const bridged = client !== null && (await reachable(client));
  if (bridged && !options.fresh) {
    const onDisk = await client!.readDoc().catch(() => ({ body: null }));
    if (onDisk.body) {
      try {
        const doc = JSON.parse(onDisk.body) as Doc;
        if (doc.version === 3) kernel.load(doc);
      } catch (err) {
        console.warn('document on disk did not parse; using the stored one', err);
      }
    }
  }

  const failed = options.safe ? [] : (await kernel.loadModules()).failed;
  for (const f of failed) console.warn('module failed to load', f.note, f.error);

  // Disk wins, for Types too. A stored document that carries its own copy of a
  // seed Type (every document before v4 did) is pointed back at the file, so an
  // edit to `seed/*.js` reaches it on reload instead of needing `?fresh=1`.
  if (!options.safe) {
    // A seed Type the stored document has never heard of is added to it — shipped
    // with the build, or sitting in `seed/` on disk.
    const known = new Set(kernel.types.list().map((t) => `${t.name}.js`));
    const onDisk = kernel.allNotes().flatMap((n) => (/^file:seed\/([\w.-]+\.js)$/.exec(n.id)?.[1] ? [n.id.slice('file:seed/'.length)] : []));
    for (const file of new Set([...Object.keys(FILES), ...onDisk])) {
      if (known.has(file)) continue;
      const note = kernel.createNote(`@${file}`);
      await kernel.defineModule(note.id).catch((err) => console.warn('seed module failed', file, err));
    }
    for (const t of kernel.types.list()) {
      if (!t.source || !(`${t.name}.js` in FILES) || pointer(kernel.body(t.source)) !== null) continue;
      kernel.patch(t.source, `@${t.name}.js`);
      await kernel.defineModule(t.source);
    }
    kernel.journal.clear();
  }

  // The repo, as Notes, before anything renders — the tree has nothing to show
  // otherwise. No bridge (any production build) means no file Notes, and the app
  // is just the seed.
  let files: Sync | null = null;
  let doc: DocSync | null = null;
  if (bridged) {
    kernel.fs = client;
    files = await sync(kernel, client!);
    doc = syncDoc(kernel, client!);
  }

  for (const pin of kernel.allPins()) applyPolicy(kernel, pin);
  kernel.watch((c) => {
    if (c.kind === 'pin:add' && kernel.hasPin(c.pin)) applyPolicy(kernel, kernel.getPin(c.pin));
  });

  // Hot: `seed/<name>.js` changed on disk (an agent wrote a Type) → recompile it
  // now. The canvas hears `defined` and remounts every pin of that Type. A file
  // that is new gets a pointer Note, so it is a module from here on.
  if (bridged && !options.safe) {
    let pending: Promise<void> = Promise.resolve();
    kernel.watch((c) => {
      if (c.kind !== 'patch' && c.kind !== 'doc') return;
      const file = c.note && /^file:seed\/([\w.-]+\.js)$/.exec(c.note)?.[1];
      if (!file || !kernel.hasNote(c.note!)) return;
      pending = pending.then(async () => {
        let note = kernel.allNotes().find((n) => pointer(n.body) === file)?.id;
        if (!note) note = kernel.createNote(`@${file}`).id;
        try {
          const info = await kernel.defineModule(note);
          kernel.spine.emit(note, 'defined', { name: info.name });
        } catch (err) {
          console.warn('seed module did not compile', file, err);
        }
      });
    });
  }

  const save = autosave(kernel, store);
  const shell = shellPin(kernel);

  if (options.safe || !shell) {
    safeShell(kernel, root, options.safe ? 'asked for' : 'the root Note has no single shell pin');
    return { kernel, save, shell: null, files, doc };
  }

  let factory = kernel.types.has(shell.type) ? kernel.types.get(shell.type) : null;
  if (!factory || !mount(kernel, root, shell.id)) {
    safeShell(kernel, root, `${shell.type} did not mount`);
    return { kernel, save, shell: null, files, doc };
  }

  // Editing the shell from inside the shell: when its Type is redefined, tear the
  // old one down and mount the new one. Compare factories — `types.watch` fires
  // for every definition, not just this one.
  kernel.types.watch(() => {
    const now = kernel.types.has(shell.type) ? kernel.types.get(shell.type) : null;
    if (!now || now === factory) return;
    factory = now;
    kernel.detach(shell.id);
    root.replaceChildren();
    if (!mount(kernel, root, shell.id)) safeShell(kernel, root, `${shell.type} did not mount`);
  });

  return { kernel, save, shell: shell.id, files, doc };
}

/** Rule 6: the root Note has exactly one pin, and that pin is the app. */
function shellPin(kernel: Kernel): Pin | undefined {
  const pins = kernel.childPins(kernel.root);
  return pins.length === 1 ? pins[0] : undefined;
}

function mount(kernel: Kernel, root: HTMLElement, pinId: PinId): boolean {
  const pin = kernel.getPin(pinId);
  try {
    const instance = kernel.types.get(pin.type)(kernel.host(pinId));
    kernel.attach(pinId, instance);
    instance.mount(root, kernel.note(pin.note));
    return true;
  } catch (err) {
    console.warn('shell failed to mount', err);
    kernel.detach(pinId);
    root.replaceChildren();
    return false;
  }
}
