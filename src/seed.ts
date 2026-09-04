import type { Doc } from './kernel/kernel';
import raw from '../seed/doc.json';
import deskJs from '../seed/desk.js?raw';
import stubJs from '../seed/stub.js?raw';
import paletteJs from '../seed/palette.js?raw';
import treeJs from '../seed/tree.js?raw';
import gitPanelJs from '../seed/git-panel.js?raw';

/**
 * The seed document: the app as it ships. The Desk, the palette, the Stub — all
 * Notes. `src/` holds the kernel and the two Types you need to repair a broken
 * one; everything else is in here.
 *
 * A Note body of exactly `@name.js` is a pointer to the file of that name. That
 * is the whole seed format, and it round-trips: see `eject.ts`.
 */
export const FILES: Record<string, string> = {
  'desk.js': deskJs,
  'stub.js': stubJs,
  'palette.js': paletteJs,
  'tree.js': treeJs,
  'git-panel.js': gitPanelJs,
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
