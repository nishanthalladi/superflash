// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { FS } from '../src/kernel/grants';
import { fakeFs, image, mountCanvas, mountOne, until } from './help';

beforeEach(() => document.body.replaceChildren());

describe('image: text body, media by reference', () => {
  it('draws the path on line two as an img, and the caption writes back', () => {
    const k = new Kernel();
    const root = document.createElement('div');
    document.body.append(root);
    const { pin } = mountOne(k, root, 'image', image);
    const note = k.getPin(pin).note;
    k.patch(note, 'Sunset\nmedia/2026-09-18-141200.png\n\nover the bay');

    const img = root.querySelector<HTMLImageElement>('img.image-pic')!;
    expect(img.getAttribute('src')).toBe('/media/2026-09-18-141200.png');
    expect(document.getElementById('type-image')).not.toBeNull();

    const cap = root.querySelector<HTMLInputElement>('.image-caption')!;
    expect(cap.value).toBe('over the bay');
    cap.value = 'at dusk';
    cap.dispatchEvent(new Event('input', { bubbles: true }));
    expect(k.body(note)).toBe('Sunset\nmedia/2026-09-18-141200.png\n\nat dusk');
    cap.value = '';
    cap.dispatchEvent(new Event('input', { bubbles: true }));
    expect(k.body(note)).toBe('Sunset\nmedia/2026-09-18-141200.png');
  });

  it('pasting an image onto the canvas stores it in media/ and pins an image box', async () => {
    const k = new Kernel();
    const { fs, media } = fakeFs();
    k.fs = fs;
    k.types.define('image', image, { title: 'Image' });
    const root = document.createElement('div');
    document.body.append(root);
    const desk = k.createNote('desk');
    const { pin } = mountCanvas(k, root, desk.id);
    k.grants.give(pin, FS); // the policy gives every canvas `fs`; the test helper does not

    const file = new File([new Uint8Array([137, 80, 78, 71])], 'x.png', { type: 'image/png' });
    const items = [{ type: 'image/png', getAsFile: () => file }];
    const e = new Event('paste', { cancelable: true }) as Event & { clipboardData: unknown };
    e.clipboardData = { items, getData: () => '' };
    window.dispatchEvent(e);

    await until(() => k.childPins(desk.id).length === 1);
    expect(media).toHaveLength(1);
    expect(media[0]!.type).toBe('image/png');
    expect(media[0]!.name).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}\.png$/);
    expect(media[0]!.base64).toBe('iVBORw==');
    const made = k.childPins(desk.id)[0]!;
    expect(made.type).toBe('image');
    expect(k.body(made.note)).toBe(`\nmedia/${media[0]!.name}`);
    expect(root.querySelector<HTMLImageElement>('.pin img')!.getAttribute('src')).toBe(`/media/${media[0]!.name}`);
  });
});
