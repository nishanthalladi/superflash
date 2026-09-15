// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { stage0 } from '../src/stage0';
import { Kernel } from '../src/kernel/kernel';
import { memoryStore } from '../src/kernel/persist';
import { fileNote, sync } from '../src/files';
import { Denied, FS } from '../src/kernel/grants';
import { fakeFs, gitPanel, mountOne, tree, until } from './help';

function host(): HTMLElement {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  return root;
}

const REPO = {
  'src/kernel/kernel.ts': 'export class Kernel {}\n',
  'src/main.ts': 'boot();\n',
  'seed/canvas.js': '// the canvas\n',
  'readme.md': '# desk\n',
};

const rows = (root: ParentNode, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
const byText = (root: ParentNode, sel: string, text: string) => rows(root, sel).find((b) => b.textContent === text);

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('the repo is on the canvas', () => {
  it('boots with a Note per file', async () => {
    const { kernel, files } = await stage0(host(), memoryStore(), { fs: fakeFs(REPO).fs });
    expect(kernel.body(fileNote('src/kernel/kernel.ts'))).toBe('export class Kernel {}\n');
    expect(files).not.toBeNull();
  });

  it('has no file Notes at all without a bridge', async () => {
    const { kernel, files } = await stage0(host(), memoryStore(), { fs: null });
    expect(files).toBeNull();
    expect(kernel.fs).toBeNull();
    expect(kernel.allNotes().some((n) => n.id.startsWith('file:'))).toBe(false);
  });

  it('typing in a file box writes the file', async () => {
    const root = host();
    const { fs, files } = fakeFs(REPO);
    const booted = await stage0(root, memoryStore(), { fs });
    const canvas = booted.kernel.getPin(booted.shell!);
    const instance = booted.kernel.instance(booted.shell!) as unknown as {
      reveal(note: string, type: string, size: [number, number]): string;
    };

    instance.reveal(fileNote('readme.md'), 'code', [400, 300]);
    void canvas;

    const area = root.querySelector<HTMLTextAreaElement>('.pin[data-type="code"] .code-source')!;
    area.value = '# edited from the canvas\n';
    area.dispatchEvent(new Event('input', { bubbles: true }));

    await booted.files!.flush();
    expect(files.get('readme.md')).toBe('# edited from the canvas\n');
  });

  it('a code box on a file shows the path and offers no Run', async () => {
    const root = host();
    const booted = await stage0(root, memoryStore(), { fs: fakeFs(REPO).fs });
    const instance = booted.kernel.instance(booted.shell!) as unknown as {
      reveal(note: string, type: string, size: [number, number]): string;
    };
    instance.reveal(fileNote('readme.md'), 'code', [400, 300]);

    const el = root.querySelector<HTMLElement>('.pin[data-type="code"]')!;
    expect(el.querySelector('.code-status')!.textContent).toBe('readme.md');
    expect(el.querySelector('button')).toBeNull();
  });
});

describe('the tree, when you pin one', () => {
  it('lists the repo and asks the canvas to open a file', async () => {
    const root = host();
    const kernel = new Kernel();
    const { fs } = fakeFs(REPO);
    kernel.fs = fs;
    const { instance } = mountOne(kernel, root, 'tree', tree);
    void instance;

    await until(() => rows(root, '.tree-file').length > 0);
    expect(root.querySelector('.tree-status')!.textContent).toContain('4 files');
    expect(byText(root, '.tree-file', 'readme.md')).toBeDefined();
    expect(byText(root, '.tree-dir', '▾ src')).toBeDefined();

    const heard: unknown[] = [];
    kernel.spine.subscribeAll((fact) => heard.push(fact));
    byText(root, '.tree-file', 'readme.md')!.click();
    expect(heard).toEqual([expect.objectContaining({ name: 'open-file', data: { path: 'readme.md' } })]);
  });

  it('says so when there is no bridge', async () => {
    const root = host();
    const kernel = new Kernel();
    mountOne(kernel, root, 'tree', tree);
    await until(() => (root.querySelector('.tree-status')!.textContent ?? '').includes('no bridge'));
  });

  it('reaches an opened file through the canvas', async () => {
    const root = host();
    const { fs } = fakeFs(REPO);
    const booted = await stage0(root, memoryStore(), { fs });
    const canvasNote = booted.kernel.getPin(booted.shell!).note;

    // What the tree emits is all it takes.
    booted.kernel.spine.emit(booted.kernel.createNote('tree').id, 'open-file', { path: 'readme.md' });

    const pins = booted.kernel.childPins(canvasNote).filter((p) => p.note === fileNote('readme.md'));
    expect(pins).toHaveLength(1);
    expect(pins[0]!.type).toBe('code');
    // A second time focuses the pin you already have.
    booted.kernel.setFocus(null);
    booted.kernel.spine.emit(booted.kernel.createNote('tree').id, 'open-file', { path: 'readme.md' });
    expect(booted.kernel.childPins(canvasNote).filter((p) => p.note === fileNote('readme.md'))).toHaveLength(1);
    expect(booted.kernel.focus()).toBe(pins[0]!.id);
  });
});

describe('git is a capability, not a Type', () => {
  it('renders branch and status from argv calls', async () => {
    const root = host();
    const kernel = new Kernel();
    const { fs, ran } = fakeFs(REPO);
    kernel.fs = fs;
    mountOne(kernel, root, 'git-panel', gitPanel);

    await until(() => (root.querySelector('.git-status')!.textContent ?? '').includes('changed'));
    expect(root.querySelector('strong')!.textContent).toBe('main');
    expect(rows(root, '.git-file').map((b) => b.textContent)).toEqual([' M src/a.ts', '?? new.ts']);
    expect(ran).toEqual(expect.arrayContaining([['rev-parse', '--abbrev-ref', 'HEAD'], ['status', '--porcelain']]));
  });

  it('commits with an argv array, message intact', async () => {
    const root = host();
    const kernel = new Kernel();
    const { fs, ran } = fakeFs(REPO);
    kernel.fs = fs;
    mountOne(kernel, root, 'git-panel', gitPanel);
    await until(() => rows(root, '.git-file').length > 0);

    root.querySelector<HTMLInputElement>('.git-message')!.value = 'fix: $(whoami) && `ls`';
    byText(root, 'button', 'commit')!.click();
    await until(() => ran.some((args) => args[0] === 'commit'));

    expect(ran.find((args) => args[0] === 'commit')).toEqual(['commit', '-m', 'fix: $(whoami) && `ls`']);
    expect(ran.find((args) => args[0] === 'add')).toEqual(['add', '--', 'src/a.ts', 'new.ts']);
  });

  it('says "no repo" rather than "clean"', async () => {
    const root = host();
    const kernel = new Kernel();
    const { fs } = fakeFs(REPO);
    fs.git = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository\n' });
    kernel.fs = fs;
    mountOne(kernel, root, 'git-panel', gitPanel);

    await until(() => (root.querySelector('.git-status')!.textContent ?? '').includes('not a git repository'));
    expect(root.querySelector('.git-status')!.classList.contains('bad')).toBe(true);
  });

  it('refuses a commit with no message', async () => {
    const root = host();
    const kernel = new Kernel();
    const { fs, ran } = fakeFs(REPO);
    kernel.fs = fs;
    mountOne(kernel, root, 'git-panel', gitPanel);
    await until(() => rows(root, '.git-file').length > 0);

    byText(root, 'button', 'commit')!.click();
    expect(root.querySelector('.git-status')!.textContent).toContain('needs a message');
    expect(ran.some((args) => args[0] === 'commit')).toBe(false);
  });
});

describe('the fs grant', () => {
  it('is held by a box, and denied to a Type the policy does not name', async () => {
    const booted = await stage0(host(), memoryStore(), { fs: fakeFs(REPO).fs });
    const box = booted.kernel.allPins().find((p) => p.type === 'box')!;
    expect(booted.kernel.grants.has(box.id, FS)).toBe(true);

    booted.kernel.types.define('nosy', () => ({ mount() {} }));
    const nosy = booted.kernel.pin(
      booted.kernel.createNote('').id,
      booted.kernel.getPin(booted.shell!).note,
      'nosy',
    );
    expect(() => booted.kernel.host(nosy.id).fs()).toThrow(Denied);
  });
});

describe('undo reaches into the repo', () => {
  it('rewrites the file when you undo an edit to it', async () => {
    const kernel = new Kernel();
    const { fs, files } = fakeFs(REPO);
    const mirror = await sync(kernel, fs, { delay: 0 });

    kernel.patch(fileNote('readme.md'), '# changed\n');
    await mirror.flush();
    expect(files.get('readme.md')).toBe('# changed\n');

    kernel.journal.undo();
    await mirror.flush();
    // Alarming, and correct: Cmd+Z is a write.
    expect(files.get('readme.md')).toBe('# desk\n');
    mirror.stop();
  });
});
