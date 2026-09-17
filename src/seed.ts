import type { Doc } from './kernel/kernel';
import raw from '../seed/doc.json';
import canvasJs from '../seed/canvas.js?raw';
import treeJs from '../seed/tree.js?raw';
import gitPanelJs from '../seed/git-panel.js?raw';
import splitJs from '../seed/split.js?raw';
import textJs from '../seed/text.js?raw';
import chatJs from '../seed/chat.js?raw';

/**
 * The seed document: the app as it ships — a blank canvas with one box on it.
 * The canvas itself is a Note, as are the tools that are not pinned anywhere yet
 * (the tree, the git panel, the split layout: compiled, waiting to be pinned).
 *
 * `src/` holds the kernel and the two Types you need to repair a broken one.
 *
 * A Note body of exactly `@name.js` is a pointer to the file of that name. The
 * pointer *stays* in the document: it is resolved when the module compiles, so a
 * stored document always runs the `seed/*.js` on disk, and an edit to the file
 * reaches every browser on reload. Nothing is baked in. See `eject.ts`.
 */
export const FILES: Record<string, string> = {
  'canvas.js': canvasJs,
  'tree.js': treeJs,
  'git-panel.js': gitPanelJs,
  'split.js': splitJs,
  'text.js': textJs,
  'chat.js': chatJs,
};

const POINTER = /^@([\w.-]+\.js)$/;

export const pointer = (body: string): string | null => POINTER.exec(body.trim())?.[1] ?? null;

/** What a module body compiles as: the file it points at, or itself. */
export function resolve(body: string): string {
  const file = pointer(body);
  if (file === null) return body;
  const source = FILES[file];
  if (source === undefined) throw new Error(`seed points at a missing file: ${file}`);
  return source;
}

export function seedDoc(): Doc {
  const doc = structuredClone(raw) as unknown as Doc;
  for (const note of doc.notes) resolve(note.body); // fail at boot, not at first compile
  return doc;
}
