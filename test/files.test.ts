import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { fileNote, filePath, sync } from '../src/files';
import { fakeFs } from './help';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the repo is the document', () => {
  it('gives every file a Note, keyed by its path', async () => {
    const kernel = new Kernel();
    const { fs } = fakeFs({ 'src/a.ts': 'a', 'readme.md': '# hi' });
    await sync(kernel, fs);

    expect(kernel.body(fileNote('src/a.ts'))).toBe('a');
    expect(kernel.body(fileNote('readme.md'))).toBe('# hi');
    expect(filePath('file:src/a.ts')).toBe('src/a.ts');
    expect(filePath('note_1_x')).toBeNull();
  });

  it('writes the file when the Note is patched', async () => {
    const kernel = new Kernel();
    const { fs, files } = fakeFs({ 'src/a.ts': 'a' });
    const mirror = await sync(kernel, fs, { delay: 0 });

    kernel.patch(fileNote('src/a.ts'), 'changed');
    await mirror.flush();

    expect(files.get('src/a.ts')).toBe('changed');
    mirror.stop();
  });

  it('coalesces a burst of keystrokes into one write', async () => {
    const kernel = new Kernel();
    const { fs, writes } = fakeFs({ 'src/a.ts': '' });
    const mirror = await sync(kernel, fs, { delay: 5 });

    for (const body of ['h', 'he', 'hel', 'hell', 'hello']) kernel.patch(fileNote('src/a.ts'), body);
    await tick(20);
    await mirror.flush();

    expect(writes).toEqual(['src/a.ts']);
    mirror.stop();
  });

  it('picks up an edit made outside the app', async () => {
    const kernel = new Kernel();
    const { fs, outside } = fakeFs({ 'src/a.ts': 'a' });
    const mirror = await sync(kernel, fs);

    outside('src/a.ts', 'from vim');
    await mirror.pull();

    expect(kernel.body(fileNote('src/a.ts'))).toBe('from vim');
    mirror.stop();
  });

  it('notices a new file and prunes a deleted one', async () => {
    const kernel = new Kernel();
    const { fs, files, outside } = fakeFs({ 'src/a.ts': 'a' });
    const mirror = await sync(kernel, fs);

    outside('src/b.ts', 'b');
    files.delete('src/a.ts');
    await mirror.pull();

    expect(kernel.hasNote(fileNote('src/b.ts'))).toBe(true);
    expect(kernel.hasNote(fileNote('src/a.ts'))).toBe(false);
    mirror.stop();
  });

  it('keeps a deleted file whose Note is still pinned', async () => {
    const kernel = new Kernel();
    kernel.types.define('code', () => ({ mount() {} }));
    const { fs, files } = fakeFs({ 'src/a.ts': 'a' });
    const mirror = await sync(kernel, fs);
    const desk = kernel.createNote('desk');
    kernel.pin(fileNote('src/a.ts'), desk.id, 'code');

    files.delete('src/a.ts');
    await mirror.pull();

    // Dropping it would leave a pin pointing at nothing.
    expect(kernel.hasNote(fileNote('src/a.ts'))).toBe(true);
    mirror.stop();
  });

  it('does not let a poll overwrite what you are typing', async () => {
    const kernel = new Kernel();
    const { fs, outside } = fakeFs({ 'src/a.ts': 'a' });
    const mirror = await sync(kernel, fs, { delay: 1000 });

    kernel.patch(fileNote('src/a.ts'), 'mine, unsaved');
    outside('src/a.ts', 'theirs');
    await mirror.pull();

    expect(kernel.body(fileNote('src/a.ts'))).toBe('mine, unsaved');
    mirror.stop();
  });

  it('stops watching when told to', async () => {
    const kernel = new Kernel();
    const { fs, writes } = fakeFs({ 'src/a.ts': 'a' });
    const mirror = await sync(kernel, fs, { delay: 0 });
    mirror.stop();

    kernel.patch(fileNote('src/a.ts'), 'ignored');
    await tick(10);

    expect(writes).toEqual([]);
  });
});
