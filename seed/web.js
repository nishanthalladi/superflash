export const type = {
  name: 'web',
  title: 'Web',
  icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8 H13.5 M8 2.5 C5.5 5.5 5.5 10.5 8 13.5 C10.5 10.5 10.5 5.5 8 2.5"/></svg>',
};

/**
 * Web. A note whose body is a URL:
 *
 *   <page title>
 *   <url>
 *
 *   <the page's readable text, cached>
 *
 * The box shows the live page in an iframe; the bridge fetches the text once so
 * an agent reading the note gets the page without a browser.
 */

const URL_RE = /^https?:\/\/\S+$/;
const nameOf = (b) => b.split('\n')[0] || '';
const urlOf = (b) => (b.split('\n')[1] || '').trim();
const textOf = (b) => {
  const i = b.indexOf('\n\n');
  return i < 0 ? '' : b.slice(i + 2);
};
const join = (name, url, text) => `${name}\n${url}${text ? `\n\n${text}` : ''}`;

const CSS = `
.web { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.web-bar { display: flex; gap: 6px; padding: 4px 6px; border-bottom: 1px solid var(--edge); background: var(--paper-2); }
.web-url { flex: 1; min-width: 0; border: 1px solid var(--edge); border-radius: 4px; padding: 2px 6px;
  font: 12px var(--mono); color: var(--ink); background: var(--paper); }
.web-url:focus { outline: none; border-color: var(--focus); }
.web-toggle { border: 0; background: transparent; color: var(--dim); font: 12px var(--mono); cursor: pointer; }
.web-frame { flex: 1; min-height: 0; border: 0; background: var(--paper); }
.web-cache { display: none; flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 8px 12px;
  font: 12px/1.5 var(--mono); color: var(--ink-2); white-space: pre-wrap; background: var(--paper); }
.web.show-text .web-frame { display: none; }
.web.show-text .web-cache { display: block; }
`;

export default function (host) {
  let box;
  let bar;
  let frame;
  let cache;

  const body = () => host.read(host.pin.note);

  async function load(url) {
    url = url.trim();
    if (!URL_RE.test(url)) return;
    host.write(join(nameOf(body()), url, textOf(body())));
    frame.src = url;
    try {
      const { title, text } = await host.fs().web(url);
      host.write(join(title || nameOf(body()) || url, url, text));
    } catch (err) {
      cache.textContent = `! ${err && err.message ? err.message : String(err)}`;
      box.classList.add('show-text');
    }
  }

  function draw() {
    const b = body();
    const url = urlOf(b);
    if (document.activeElement !== bar && bar.value !== url) bar.value = url;
    if (url && frame.getAttribute('src') !== url) frame.src = url;
    cache.textContent = textOf(b);
  }

  return {
    mount(el, note) {
      box = el;
      box.classList.add('web');
      if (!document.getElementById('type-web')) {
        const style = document.createElement('style');
        style.id = 'type-web';
        style.textContent = CSS;
        document.head.append(style);
      }
      bar = document.createElement('input');
      bar.className = 'web-url';
      bar.placeholder = 'https://';
      bar.spellcheck = false;
      bar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void load(bar.value);
        e.stopPropagation();
      });
      // A URL typed or pasted into an empty box is the URL.
      bar.addEventListener('input', () => {
        if (!urlOf(body()) && URL_RE.test(bar.value.trim())) void load(bar.value);
      });
      const toggle = document.createElement('button');
      toggle.className = 'web-toggle';
      toggle.textContent = 'text';
      toggle.addEventListener('click', () => box.classList.toggle('show-text'));
      const head = document.createElement('div');
      head.className = 'web-bar';
      head.append(bar, toggle);

      frame = document.createElement('iframe');
      frame.className = 'web-frame';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      cache = document.createElement('pre');
      cache.className = 'web-cache';
      box.append(head, frame, cache);
      box.addEventListener('paste', (e) => {
        if (urlOf(body())) return;
        const t = (e.clipboardData ? e.clipboardData.getData('text/plain') : '').trim();
        if (!URL_RE.test(t)) return;
        e.preventDefault();
        e.stopPropagation();
        void load(t);
      });

      draw();
      if (urlOf(note.body) && !textOf(note.body)) void load(urlOf(note.body));
    },

    focus() {
      bar.focus();
    },

    onPatch() {
      draw();
    },

    load,
  };
}
