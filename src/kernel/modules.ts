import type { NoteId } from './model';
import type { Registry, TypeFactory, TypeInfo } from './type';

/** What `defineModule` needs. Keeps this file out of Kernel's import cycle. */
export interface ModuleTarget {
  body(note: NoteId): string;
  types: Registry;
}

export class BadModule extends Error {
  constructor(
    message: string,
    readonly note: NoteId,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BadModule';
  }
}

export type Loader = (source: string) => Promise<Record<string, unknown>>;

/**
 * Turn source text into a live module. A Blob URL in the browser; a data URL
 * where there is no Blob (tests, Node). Either way the import is real ESM, so a
 * module can use `import` and top-level await.
 */
/**
 * Compile source into a live module by importing it as a data URL. Real ESM in
 * both the browser and Node, and no `eval`.
 *
 * The trade: a data URL has no base, so a module cannot `import` a relative path
 * or a bare specifier. Modules are self-contained — everything they need comes in
 * through `host`.
 */
export const loadSource: Loader = async (source) => {
  const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`;
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
};

/** The shape a module Note must export. */
export const MODULE_TEMPLATE = `export const type = { name: 'my-type', title: 'My Type' };

export default function (host) {
  return {
    mount(box, note) {
      box.textContent = note.body || 'hello from a module';
    },
  };
}
`;

/**
 * Compile a Note into a Type and register it.
 *
 * On any failure the registry is left exactly as it was — a broken edit cannot
 * unregister a working Type, which is what makes editing modules from inside the
 * app survivable.
 */
export async function defineModule(
  target: ModuleTarget,
  note: NoteId,
  load: Loader = loadSource,
): Promise<TypeInfo> {
  const source = target.body(note);
  if (!source.trim()) throw new BadModule('module Note is empty', note);

  let mod: Record<string, unknown>;
  try {
    mod = await load(source);
  } catch (err) {
    throw new BadModule(err instanceof Error ? err.message : String(err), note, err);
  }

  const factory = mod['default'];
  if (typeof factory !== 'function') {
    throw new BadModule('module must `export default` a Type factory', note);
  }

  const manifest = (mod['type'] ?? {}) as Partial<TypeInfo>;
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (!name) {
    throw new BadModule("module must `export const type = { name: '...' }`", note);
  }

  return target.types.define(name, factory as TypeFactory, {
    title: typeof manifest.title === 'string' ? manifest.title : name,
    source: note,
  });
}
