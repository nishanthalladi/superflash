import type { Kernel } from './kernel/kernel';
import { POLICY } from './stage0';

/**
 * The way out. Turns the live document back into the `seed/` files it came from,
 * so what you built inside the app lands in the repo instead of rotting in
 * localStorage.
 *
 * Without this, "work on the project from inside the project" is a demo.
 */
export function eject(kernel: Kernel): Record<string, string> {
  const doc = kernel.toJSON();
  const files: Record<string, string> = {};
  const byNote = new Map(kernel.types.list().flatMap((t) => (t.source ? [[t.source, t.name]] : [])));

  // Policy hands these out at every boot, so storing them would be noise — and
  // would let an ejected document claim powers the policy no longer grants.
  doc.grants = doc.grants
    .map(([pin, grants]) => {
      const fromPolicy = new Set(POLICY[kernel.getPin(pin).type] ?? []);
      return [pin, grants.filter((g) => !fromPolicy.has(g))] as (typeof doc.grants)[number];
    })
    .filter(([, grants]) => grants.length > 0);

  for (const note of doc.notes) {
    const name = byNote.get(note.id);
    if (!name) continue;
    const file = `${name}.js`;
    files[file] = note.body;
    note.body = `@${file}`;
  }

  files['doc.json'] = `${JSON.stringify(doc, null, 2)}\n`;
  return files;
}

/**
 * Write the files into a directory the user picks. Falls back to one download
 * per file where the File System Access API is missing.
 *
 * ponytail: no zip, so no dependency. Firefox and Safari get a pile of
 * downloads; add JSZip only if that turns out to be the common path.
 */
export async function ejectToDisk(kernel: Kernel): Promise<string[]> {
  const files = eject(kernel);
  const picker = (globalThis as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;

  if (picker) {
    const dir = await picker.call(globalThis);
    for (const [name, body] of Object.entries(files)) {
      const handle = await dir.getFileHandle(name, { create: true });
      const stream = await handle.createWritable();
      await stream.write(body);
      await stream.close();
    }
    return Object.keys(files);
  }

  for (const [name, body] of Object.entries(files)) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  return Object.keys(files);
}
