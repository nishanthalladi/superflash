import { Kernel } from './kernel/kernel';
import { CREATE, DEFINE, FS, MACHINE, SHELL, TYPES } from './kernel/grants';
import type { Grant } from './kernel/grants';
import type { Pin, PinId } from './kernel/model';
import { autosave, readDoc, snapshot } from './kernel/persist';
import type { Store } from './kernel/persist';
import { box } from './types/box';
import { code } from './types/code';
import type { FsClient } from './kernel/type';
import { httpFs, reachable, sync } from './files';
import type { Sync } from './files';
import { seedDoc } from './seed';
import { safeShell } from './safe';

/**
 * Grant policy: which powers a pin gets purely from its Type.
 *
 * This is the trust root, so it stays in `src/` — the thing being governed must
 * not be able to edit it. A Type written inside the app is not in this table and
 * gets nothing beyond read/write self and emit.
 */
export const POLICY: Record<string, Grant[]> = {
  canvas: [SHELL, CREATE, TYPES],
  box: [SHELL, FS, DEFINE, CREATE, TYPES, MACHINE],
  split: [SHELL],
  code: [DEFINE],
  tree: [FS],
  'git-panel': [FS],
};

export function applyPolicy(kernel: Kernel, pin: Pin): void {
  const grants = POLICY[pin.type];
  if (grants) kernel.grants.give(pin.id, ...grants);
}

/** The only Types in `src/`: a box and a file editor. Enough to repair anything. */
export function registerBuiltins(kernel: Kernel): void {
  kernel.types.define('box', box, { title: 'Box' });
  kernel.types.define('code', code, { title: 'Code' });
}

export interface Booted {
  kernel: Kernel;
  save: { stop: () => void; flush: () => void };
  /** The single pin on the root Note, if the shell mounted. */
  shell: PinId | null;
  /** The repo mirror, when there is a bridge. */
  files: Sync | null;
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
  registerBuiltins(kernel);

  const stored = options.fresh ? null : readDoc(store);
  if (stored) snapshot(store, stored);
  kernel.load(stored ?? seedDoc());

  const failed = options.safe ? [] : (await kernel.loadModules()).failed;
  for (const f of failed) console.warn('module failed to load', f.note, f.error);

  // The repo, as Notes, before anything renders — the tree has nothing to show
  // otherwise. No bridge (any production build) means no file Notes, and the app
  // is just the seed.
  const client = options.fs === undefined ? httpFs() : options.fs;
  let files: Sync | null = null;
  if (client && (await reachable(client))) {
    kernel.fs = client;
    files = await sync(kernel, client);
  }

  for (const pin of kernel.allPins()) applyPolicy(kernel, pin);
  kernel.watch((c) => {
    if (c.kind === 'pin:add' && kernel.hasPin(c.pin)) applyPolicy(kernel, kernel.getPin(c.pin));
  });

  const save = autosave(kernel, store);
  const shell = shellPin(kernel);

  if (options.safe || !shell) {
    safeShell(kernel, root, options.safe ? 'asked for' : 'the root Note has no single shell pin');
    return { kernel, save, shell: null, files };
  }

  let factory = kernel.types.has(shell.type) ? kernel.types.get(shell.type) : null;
  if (!factory || !mount(kernel, root, shell.id)) {
    safeShell(kernel, root, `${shell.type} did not mount`);
    return { kernel, save, shell: null, files };
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

  return { kernel, save, shell: shell.id, files };
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
