import type { Doc } from './kernel/kernel';
import raw from '../seed/doc.json';
import canvasJs from '../seed/canvas.js?raw';
import treeJs from '../seed/tree.js?raw';
import gitPanelJs from '../seed/git-panel.js?raw';
import splitJs from '../seed/split.js?raw';

/**
 * The seed document: the app as it ships — a blank canvas with one box on it.
 * The canvas itself is a Note, as are the tools that are not pinned anywhere yet
 * (the tree, the git panel, the split layout: compiled, waiting to be pinned).
 *
 * `src/` holds the kernel and the two Types you need to repair a broken one.
 *
 * A Note body of exactly `@name.js` is a pointer to the file of that name. That
 * is the whole seed format, and it round-trips: see `eject.ts`.
 */
export const FILES: Record<string, string> = {
  'canvas.js': canvasJs,
  'tree.js': treeJs,
  'git-panel.js': gitPanelJs,
  'split.js': splitJs,
};

const POINTER = /^@([\w.-]+\.js)$/;

export function seedDoc(): Doc {
  const doc = structuredClone(raw) as unknown as Doc;
  for (const note of doc.notes) {
    const file = POINTER.exec(note.body.trim())?.[1];
    if (!file) continue;
    const source = FILES[file];
    if (source === undefined) throw new Error(`seed points at a missing file: ${file}`);
    note.body = source;
  }
  return doc;
}
