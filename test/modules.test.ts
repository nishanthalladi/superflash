import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { BadModule, loadSource } from '../src/kernel/modules';
import type { Loader } from '../src/kernel/modules';
import { DEFINE, Denied } from '../src/kernel/grants';
import { plain as stub } from './help';

/** Compile with real ESM semantics via a data URL — no browser needed. */
const real: Loader = loadSource;

function kernel() {
  const k = new Kernel();
  k.types.define('stub', stub);
  const desk = k.createNote('desk');
  k.root = desk.id;
  return { k, desk };
}

const GOOD = `export const type = { name: 'badge', title: 'Badge' };
export default function (host) {
  return { mount(box, note) { box.textContent = 'badge:' + note.body; } };
}
`;

describe('a Note becomes a Type', () => {
  it('registers what the module names itself', async () => {
    const { k } = kernel();
    const note = k.createNote(GOOD);

    const info = await k.defineModule(note.id, real);

    expect(info).toMatchObject({ name: 'badge', title: 'Badge', source: note.id });
    expect(k.types.has('badge')).toBe(true);
    expect(k.types.list().map((t) => t.name).sort()).toEqual(['badge', 'stub']);
    expect([...k.modules]).toEqual([note.id]);
  });

  it('the registered factory is the one the Note exports', async () => {
    const { k, desk } = kernel();
    const note = k.createNote(GOOD);
    await k.defineModule(note.id, real);

    const target = k.createNote('hi');
    const pin = k.pin(target.id, desk.id, 'badge');
    const box = { textContent: '' } as unknown as HTMLElement;
    k.types.get('badge')(k.host(pin.id)).mount(box, k.note(target.id));

    expect(box.textContent).toBe('badge:hi');
  });

  it('re-running a module replaces the Type for new mounts', async () => {
    const { k } = kernel();
    const note = k.createNote(GOOD);
    await k.defineModule(note.id, real);
    const first = k.types.get('badge');

    k.patch(note.id, GOOD.replace("'badge:'", "'BADGE:'"));
    await k.defineModule(note.id, real);

    expect(k.types.get('badge')).not.toBe(first);
  });
});

describe('a bad module cannot break a working one', () => {
  const cases: [string, string][] = [
    ['a syntax error', 'export default function ( {'],
    ['no default export', "export const type = { name: 'badge' };"],
    ['no name', 'export default function () { return { mount() {} }; }'],
    ['an empty Note', '   '],
  ];

  for (const [label, source] of cases) {
    it(`keeps the old Type through ${label}`, async () => {
      const { k } = kernel();
      const note = k.createNote(GOOD);
      await k.defineModule(note.id, real);
      const good = k.types.get('badge');

      k.patch(note.id, source);
      await expect(k.defineModule(note.id, real)).rejects.toThrow(BadModule);

      expect(k.types.get('badge')).toBe(good);
      expect(k.modules.has(note.id)).toBe(true);
    });
  }
});

describe('boot re-registers modules', () => {
  it('a reload brings the Type back before anything renders', async () => {
    const { k, desk } = kernel();
    const note = k.createNote(GOOD);
    await k.defineModule(note.id, real);
    k.pin(note.id, desk.id, 'stub');
    const doc = k.toJSON();

    const next = new Kernel();
    next.types.define('stub', stub);
    next.load(doc);
    expect(next.types.has('badge')).toBe(false);

    const { ok, failed } = await next.loadModules(real);
    expect(failed).toEqual([]);
    expect(ok.map((t) => t.name)).toEqual(['badge']);
    expect(next.types.has('badge')).toBe(true);
  });

  it('one broken module does not stop the others', async () => {
    const { k } = kernel();
    const good = k.createNote(GOOD);
    const bad = k.createNote('export default function ( {');
    await k.defineModule(good.id, real);
    k.modules.add(bad.id);

    const result = await k.loadModules(real);
    expect(result.ok.map((t) => t.name)).toEqual(['badge']);
    expect(result.failed.map((f) => f.note)).toEqual([bad.id]);
  });
});

describe('defining is a grant', () => {
  it('a Type cannot compile itself without `define`', async () => {
    const { k, desk } = kernel();
    const note = k.createNote(GOOD);
    const pin = k.pin(note.id, desk.id, 'stub');
    const host = k.host(pin.id);

    await expect(host.defineModule()).rejects.toThrow(Denied);
    expect(k.types.has('badge')).toBe(false);

    k.grants.give(pin.id, DEFINE);
    await expect(host.defineModule()).resolves.toMatchObject({ name: 'badge' });
  });
});
