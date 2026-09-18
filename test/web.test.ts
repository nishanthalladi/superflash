// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../src/kernel/kernel';
import { FS } from '../src/kernel/grants';
import { Refused, extract, fetchWeb } from '../plugins/bridge';
import { canvas, fakeFs, mountCanvas, text, until, web } from './help';

beforeEach(() => document.body.replaceChildren());

describe('web: a note whose body is a URL', () => {
  it('fetches the page on mount and caches title and text in the body', async () => {
    const k = new Kernel();
    const { fs, fetched } = fakeFs();
    k.fs = fs;
    k.types.define('web', web, { title: 'Web' });
    const root = document.createElement('div');
    document.body.append(root);
    const note = k.createNote('\nhttps://example.com');
    const pin = k.pin(note.id, k.createNote('parent').id, 'web');
    k.grants.give(pin.id, FS);
    const instance = k.types.get('web')(k.host(pin.id));
    k.attach(pin.id, instance);
    instance.mount(root, note);

    await until(() => k.body(note.id).startsWith('Example'));
    expect(fetched).toEqual(['https://example.com']);
    expect(k.body(note.id)).toBe('Example Domain\nhttps://example.com\n\nThis domain is for use in examples.');
    expect(root.querySelector<HTMLInputElement>('.web-url')!.value).toBe('https://example.com');
    expect(root.querySelector<HTMLIFrameElement>('.web-frame')!.getAttribute('src')).toBe('https://example.com');
    expect(root.querySelector('.web-cache')!.textContent).toBe('This domain is for use in examples.');
    expect(document.querySelectorAll('#type-web')).toHaveLength(1);
  });

  it('pasting one URL on the canvas makes a web box, anything else a text box', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const k = new Kernel();
    k.types.define('canvas', canvas);
    k.types.define('text', text);
    k.types.define('web', web);
    const desk = k.createNote('desk');
    mountCanvas(k, root, desk.id);

    const paste = (data: string): void => {
      const e = Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
        clipboardData: { getData: () => data },
      });
      window.dispatchEvent(e);
    };
    paste('  https://example.com/a?b=1 \n');
    (document.activeElement as HTMLElement).blur(); // the new web box took focus
    paste('two words');
    const pins = k.allPins().filter((p) => p.parent === desk.id);
    expect(pins.map((p) => [p.type, k.body(p.note)])).toEqual([
      ['web', '\nhttps://example.com/a?b=1'],
      ['text', '\ntwo words'],
    ]);
  });
});

describe('bridge: /_web', () => {
  it('extracts a title and readable text without a library', () => {
    const html = `<html><head><title> Hi &amp; bye </title><style>p{}</style></head>
      <body><nav><a href="/">Home</a></nav><script>alert(1)</script>
      <h1>Hello</h1><p>One&nbsp;two<br>three</p><!-- c --><footer>foot</footer></body></html>`;
    expect(extract(html)).toEqual({ title: 'Hi & bye', text: 'Hello\nOne two\nthree' });
  });

  it('refuses private hosts and non-http schemes before fetching', async () => {
    for (const bad of [
      'http://127.0.0.1/',
      'http://localhost:5173/',
      'http://10.1.2.3/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'file:///etc/passwd',
      'not a url',
    ]) {
      await expect(fetchWeb(bad), bad).rejects.toBeInstanceOf(Refused);
    }
  });
});
