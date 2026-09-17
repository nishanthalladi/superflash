// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { stage0 } from '../src/stage0';
import { memoryStore } from '../src/kernel/persist';
import { eject } from '../src/eject';
import { seedDoc } from '../src/seed';
import type { Doc } from '../src/kernel/kernel';

function host(): HTMLElement {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  return root;
}

/** What `src/seed.ts` does, over ejected files instead of the shipped ones. */
function rehydrate(files: Record<string, string>): Doc {
  const doc = JSON.parse(files['doc.json']!) as Doc;
  for (const note of doc.notes) {
    const pointer = /^@([\w.-]+\.js)$/.exec(note.body.trim());
    if (pointer && files[pointer[1]!] !== undefined) note.body = files[pointer[1]!]!;
  }
  return doc;
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('eject', () => {
  it('writes the document, and leaves seed pointers pointing at disk', async () => {
    const { kernel } = await stage0(host(), memoryStore(), { fs: null });
    const files = eject(kernel);

    // The shipped Types are not copied out: the document never held their source.
    expect(Object.keys(files)).toEqual(['doc.json']);
    expect(JSON.parse(files['doc.json']!).notes.map((n: { body: string }) => n.body)).toContain('@canvas.js');
  });

  it('round-trips: eject, rebuild, boot fresh, same document', async () => {
    const { kernel } = await stage0(host(), memoryStore(), { fs: null });
    const before = kernel.toJSON();

    const rebuilt = rehydrate(eject(kernel));
    expect(rebuilt).toEqual(seedDoc());

    const root = host();
    const second = await stage0(root, memoryStore(), { fresh: true, fs: null });
    second.kernel.load(rebuilt);
    await second.kernel.loadModules();

    expect(second.kernel.toJSON()).toEqual(before);
  });

  it('carries a Type written inside the app out to a file', async () => {
    const { kernel } = await stage0(host(), memoryStore(), { fs: null });
    const note = kernel.createNote(
      "export const type = { name: 'tick' };\nexport default () => ({ mount(box) { box.textContent = 'x'; } });",
    );
    await kernel.defineModule(note.id);

    const files = eject(kernel);
    expect(files['tick.js']).toContain("name: 'tick'");
    expect(JSON.parse(files['doc.json']!).modules).toContain(note.id);
  });
});
