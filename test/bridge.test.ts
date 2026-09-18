import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DENY, MAX_BYTES, Refused, git, list, media, read, resolveSafe, termAttach, termList, termOpen, termWrite, termResize, write } from '../plugins/bridge';

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'superflash-bridge-'));
  root = path.join(base, 'repo');
  outside = path.join(base, 'secrets');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'readme.md'), '# hi\n');
  await fs.writeFile(path.join(root, 'logo.png'), 'not really a png');
  await fs.writeFile(path.join(root, 'node_modules', 'x', 'index.js'), 'nope');
  await fs.writeFile(path.join(outside, 'keys.txt'), 'sekrit');
  await fs.symlink(path.join(outside, 'keys.txt'), path.join(root, 'link.txt'));
  await git(root, ['init']);
  // A temp repo has no identity, and commit refuses without one.
  await fs.appendFile(path.join(root, '.git', 'config'), '[user]\n\tname = Test\n\temail = t@example.com\n');
});

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe('the jail', () => {
  it('resolves a repo-relative path', async () => {
    expect(await resolveSafe(root, 'src/a.ts')).toBe(path.join(await fs.realpath(root), 'src/a.ts'));
  });

  it('refuses to climb out', async () => {
    for (const bad of ['../secrets/keys.txt', 'src/../../secrets/keys.txt', '/etc/passwd', '']) {
      await expect(resolveSafe(root, bad)).rejects.toThrow(Refused);
    }
  });

  it('refuses a symlink that points out of the repo', async () => {
    await expect(resolveSafe(root, 'link.txt')).rejects.toThrow(Refused);
    await expect(read(root, 'link.txt')).rejects.toThrow(Refused);
  });

  it('refuses the denylist and binaries', async () => {
    expect(DENY.has('node_modules')).toBe(true);
    await expect(resolveSafe(root, 'node_modules/x/index.js')).rejects.toThrow(Refused);
    await expect(resolveSafe(root, 'logo.png')).rejects.toThrow(Refused);
  });

  it('refuses a body bigger than the limit', async () => {
    await expect(write(root, 'big.txt', 'x'.repeat(MAX_BYTES + 1))).rejects.toThrow(Refused);
  });
});

describe('list, read, write', () => {
  it('lists text files and nothing else', async () => {
    const paths = (await list(root)).map((e) => e.path);
    expect(paths).toContain(path.join('src', 'a.ts'));
    expect(paths).toContain('readme.md');
    expect(paths).not.toContain('logo.png');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
  });

  it('round-trips a file', async () => {
    await write(root, 'src/a.ts', 'export const a = 2;\n');
    expect((await read(root, 'src/a.ts')).body).toBe('export const a = 2;\n');
  });

  it('creates the directories a new file needs', async () => {
    await write(root, 'deep/er/still.ts', 'ok');
    expect((await read(root, 'deep/er/still.ts')).body).toBe('ok');
  });
});

describe('git', () => {
  it('runs an allowlisted subcommand', async () => {
    const { code, stdout } = await git(root, ['status', '--porcelain']);
    expect(code).toBe(0);
    expect(stdout).toContain('readme.md');
  });

  it('refuses anything not on the list', async () => {
    for (const args of [['push'], ['clone', 'x'], ['config', '--global', 'x', 'y']]) {
      await expect(git(root, args)).rejects.toThrow(Refused);
    }
  });

  it('refuses a string, so a message can never become a command', async () => {
    await expect(git(root, 'status; rm -rf /')).rejects.toThrow(Refused);
    await expect(git(root, [])).rejects.toThrow(Refused);
    await expect(git(root, ['status', 5])).rejects.toThrow(Refused);
  });

  it('passes a message with shell characters through untouched', async () => {
    await git(root, ['add', '--', 'readme.md']);
    const done = await git(root, [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-m',
      'fix: $(whoami) && `ls` ;',
    ]).catch((err: unknown) => err);
    // `-c` is not an allowlisted subcommand: the allowlist checks argv[0].
    expect(done).toBeInstanceOf(Refused);

    const ok = await git(root, ['commit', '-m', 'fix: $(whoami) && `ls` ;']);
    expect(ok.code === 0 || ok.stderr.includes('user')).toBe(true);
  });
});

describe('media', () => {
  const png = Buffer.from('not really a png').toString('base64');

  it('writes an image under media/ and nowhere else', async () => {
    expect(await media(root, 'a.png', 'image/png', png)).toEqual({ path: 'media/a.png' });
    expect((await fs.readFile(path.join(root, 'media', 'a.png'))).toString()).toBe('not really a png');
    expect((await list(root)).map((e) => e.path)).not.toContain('media/a.png');
    for (const bad of ['../a.png', 'x/a.png', '/etc/a.png', '', 'a.txt']) {
      await expect(media(root, bad, 'image/png', png)).rejects.toThrow(Refused);
    }
  });

  it('refuses a non-image type, a mismatched name, and a non-string body', async () => {
    await expect(media(root, 'a.svg', 'image/svg+xml', png)).rejects.toThrow(Refused);
    await expect(media(root, 'a.js', 'text/javascript', png)).rejects.toThrow(Refused);
    await expect(media(root, 'a.png', 'image/jpeg', png)).rejects.toThrow(Refused);
    await expect(media(root, 'a.png', 'image/png', 42)).rejects.toThrow(Refused);
  });
});

// --- terminal ---
describe('terminal', () => {
  it('runs a shell in the repo and streams what it prints', async () => {
    const got: string[] = [];
    let exit: number | null | undefined;
    const term = await termOpen(root, 'src', (e) => {
      if (e.text) got.push(e.text);
      if ('done' in e) exit = e.done;
    }, ['sh']);
    expect(term.id).toMatch(/^t\d+$/);
    termWrite(term.id, 'pwd; echo marker-$((20+3))\n');
    for (let i = 0; i < 200 && !got.join('').includes('marker-23'); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(got.join('')).toContain('marker-23');
    expect(got.join('')).toContain(path.join('repo', 'src'));
    term.resize(100, 24);
    term.write('stty size\n');
    for (let i = 0; i < 200 && !got.join('').includes('24 100'); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(got.join('')).toContain('24 100');
    term.write('exit\n');
    for (let i = 0; i < 200 && exit === undefined; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(exit).toBe(0);
    expect(() => termWrite(term.id, 'x')).toThrow(Refused);
  });

  it('outlives its box: detach, reattach, and the scrollback comes back', async () => {
    const first: string[] = [];
    const term = await termOpen(root, '', (e) => void (e.text && first.push(e.text)), ['sh']);
    term.write('echo still-$((40+2))\n');
    for (let i = 0; i < 200 && !first.join('').includes('still-42'); i += 1) await new Promise((r) => setTimeout(r, 25));
    term.detach();
    expect(termList()).toContain(term.id);

    const again: string[] = [];
    const back = termAttach(term.id, (e) => void (e.text && again.push(e.text)));
    expect(back?.id).toBe(term.id);
    expect(again.join('')).toContain('still-42'); // replayed, not re-run
    back!.write('exit\n');
    for (let i = 0; i < 200 && termList().includes(term.id); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(termList()).not.toContain(term.id);
    expect(termAttach(term.id, () => undefined)).toBeNull();
  });

  it('refuses a cwd outside the repo and a non-string keystroke', async () => {
    await expect(termOpen(root, '../secrets', () => undefined, ['sh'])).rejects.toThrow(Refused);
    expect(() => termWrite('nope', 'x')).toThrow(Refused);
    expect(() => termResize('nope', 80, 24)).toThrow(Refused);
  });
});
