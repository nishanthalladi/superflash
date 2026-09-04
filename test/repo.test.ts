// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { stage0 } from '../src/stage0';
import { memoryStore } from '../src/kernel/persist';
import { fileNote } from '../src/files';
import { FS, Denied } from '../src/kernel/grants';
import { fakeFs, until } from './help';

function host(): HTMLElement {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  return root;
}

const REPO = {
  'src/kernel/kernel.ts': 'export class Kernel {}\n',
  'src/main.ts': 'boot();\n',
  'seed/desk.js': '// the desk\n',
  'readme.md': '# desk\n',
};

const rows = (root: ParentNode, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
const byText = (root: ParentNode, sel: string, text: string) => rows(root, sel).find((b) => b.textContent === text);

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('the repo is on the desk', () => {
  it('boots with a Note per file and a tree that lists them', async () => {
    const root = host();
    const { fs } = fakeFs(REPO);
    const { kernel } = await stage0(root, memoryStore(), { fs });

    expect(kernel.body(fileNote('src/kernel/kernel.ts'))).toBe('export class Kernel {}\n');
    await until(() => rows(root, '.tree-file').length > 0);
    expect(root.querySelector('.tree-status')!.textContent).toContain('4 files');
    // Folders, collapsed or open, plus the files inside the open ones.
    expect(byText(root, '.tree-file', 'readme.md')).toBeDefined();
    expect(byText(root, '.tree-dir', '▾ src')).toBeDefined();
  });

  it('opens a file in one pin, and focuses that pin the second time', async () => {
    const root = host();
    const { fs } = fakeFs(REPO);
    const { kernel } = await stage0(root, memoryStore(), { fs });
    await until(() => rows(root, '.tree-file').length > 0);

    byText(root, '.tree-file', 'readme.md')!.click();
    const pins = kernel.allPins().filter((p) => p.note === fileNote('readme.md'));
    expect(pins).toHaveLength(1);
    expect(pins[0]!.type).toBe('code');
    expect(kernel.focus()).toBe(pins[0]!.id);

    // A code pin on a file shows the path, and offers no "Run".
    const box = root.querySelector<HTMLElement>(`.pin[data-pin="${pins[0]!.id}"]`)!;
    expect(box.querySelector('.code-status')!.textContent).toBe('readme.md');
    expect(box.querySelector('button')).toBeNull();

    kernel.setFocus(null);
    byText(root, '.tree-file', 'readme.md')!.click();
    expect(kernel.allPins().filter((p) => p.note === fileNote('readme.md'))).toHaveLength(1);
    expect(kernel.focus()).toBe(pins[0]!.id);
  });

  it('typing in a file pin writes the file', async () => {
    const root = host();
    const { fs, files } = fakeFs(REPO);
    const booted = await stage0(root, memoryStore(), { fs });
    await until(() => rows(root, '.tree-file').length > 0);

    byText(root, '.tree-file', 'readme.md')!.click();
    const area = root.querySelector<HTMLTextAreaElement>('.pin[data-type="code"] .code-source')!;
    area.value = '# edited from the desk\n';
    area.dispatchEvent(new Event('input', { bubbles: true }));

    await booted.files!.flush();
    expect(files.get('readme.md')).toBe('# edited from the desk\n');
  });

  it('shows an outside edit without losing the pin', async () => {
    const root = host();
    const { fs, outside } = fakeFs(REPO);
    const booted = await stage0(root, memoryStore(), { fs });
    await until(() => rows(root, '.tree-file').length > 0);
    byText(root, '.tree-file', 'readme.md')!.click();

    outside('readme.md', '# changed in vim\n');
    await booted.files!.pull();

    const area = root.querySelector<HTMLTextAreaElement>('.pin[data-type="code"] .code-source')!;
    expect(area.value).toBe('# changed in vim\n');
  });

  it('has no file Notes at all without a bridge', async () => {
    const root = host();
    const { kernel, files } = await stage0(root, memoryStore(), { fs: null });
    expect(files).toBeNull();
    expect(kernel.fs).toBeNull();
    expect(kernel.allNotes().some((n) => n.id.startsWith('file:'))).toBe(false);
    // The tree says so instead of pretending.
    await until(() => (root.querySelector('.tree-status')!.textContent ?? '').includes('no bridge'));
  });
});

describe('git is a capability, not a Type', () => {
  it('renders branch and status from argv calls', async () => {
    const root = host();
    const { fs, ran } = fakeFs(REPO);
    await stage0(root, memoryStore(), { fs });
    const panel = root.querySelector<HTMLElement>('.pin[data-type="git-panel"]')!;

    await until(() => (panel.querySelector('.git-status')!.textContent ?? '').includes('changed'));
    expect(panel.querySelector('strong')!.textContent).toBe('main');
    expect(rows(panel, '.git-file').map((b) => b.textContent)).toEqual([' M src/a.ts', '?? new.ts']);
    expect(ran).toEqual(expect.arrayContaining([['rev-parse', '--abbrev-ref', 'HEAD'], ['status', '--porcelain']]));
  });

  it('commits with an argv array, message intact', async () => {
    const root = host();
    const { fs, ran } = fakeFs(REPO);
    await stage0(root, memoryStore(), { fs });
    const panel = root.querySelector<HTMLElement>('.pin[data-type="git-panel"]')!;
    await until(() => rows(panel, '.git-file').length > 0);

    const message = panel.querySelector<HTMLInputElement>('.git-message')!;
    message.value = 'fix: $(whoami) && `ls`';
    byText(panel, 'button', 'commit')!.click();
    await until(() => ran.some((args) => args[0] === 'commit'));

    expect(ran.find((args) => args[0] === 'commit')).toEqual(['commit', '-m', 'fix: $(whoami) && `ls`']);
    expect(ran.find((args) => args[0] === 'add')).toEqual(['add', '--', 'src/a.ts', 'new.ts']);
  });

  it('says "no repo" rather than "clean"', async () => {
    const root = host();
    const { fs } = fakeFs(REPO);
    fs.git = async (args) =>
      args[0] === 'status'
        ? { code: 128, stdout: '', stderr: 'fatal: not a git repository\n' }
        : { code: 128, stdout: '', stderr: '' };
    await stage0(root, memoryStore(), { fs });
    const panel = root.querySelector<HTMLElement>('.pin[data-type="git-panel"]')!;

    await until(() => (panel.querySelector('.git-status')!.textContent ?? '').includes('not a git repository'));
    expect(panel.querySelector('.git-status')!.classList.contains('bad')).toBe(true);
  });

  it('refuses a commit with no message', async () => {
    const root = host();
    const { fs, ran } = fakeFs(REPO);
    await stage0(root, memoryStore(), { fs });
    const panel = root.querySelector<HTMLElement>('.pin[data-type="git-panel"]')!;
    await until(() => rows(panel, '.git-file').length > 0);

    byText(panel, 'button', 'commit')!.click();
    expect(panel.querySelector('.git-status')!.textContent).toContain('needs a message');
    expect(ran.some((args) => args[0] === 'commit')).toBe(false);
  });
});

describe('the fs grant', () => {
  it('is held by the Types that need the repo, and nobody else', async () => {
    const booted = await stage0(host(), memoryStore(), { fs: fakeFs(REPO).fs });
    const holds = (type: string): boolean =>
      booted.kernel.grants.has(booted.kernel.allPins().find((p) => p.type === type)!.id, FS);

    expect(holds('tree')).toBe(true);
    expect(holds('git-panel')).toBe(true);
    expect(holds('cell')).toBe(true);
    expect(holds('stub')).toBe(false);
  });

  it('is denied to a Type the policy does not name', async () => {
    const booted = await stage0(host(), memoryStore(), { fs: fakeFs(REPO).fs });
    const stub = booted.kernel.allPins().find((p) => p.type === 'stub')!;
    expect(() => booted.kernel.host(stub.id).fs()).toThrow(Denied);
  });
});
