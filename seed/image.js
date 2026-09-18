export const type = {
  name: 'image',
  title: 'Image',
  icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M3 12 L6.5 8 L9 10.5 L11 8.5 L13 11"/><circle cx="10.5" cy="5.5" r="1" fill="currentColor" stroke="none"/></svg>',
};

/**
 * Image. The body is text, the picture is a file in the repo:
 *
 *   name            line one
 *   media/x.png     line two, the path
 *                   a blank line
 *   caption         everything after, optional
 *
 * Media by reference, so a note stays text and the repo stays the document.
 */

const lines = (body) => body.split('\n');
const pathOf = (body) => (lines(body)[1] || '').trim();
const captionOf = (body) => lines(body).slice(3).join('\n');

const CSS = `
.image { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.image-pic { flex: 1; min-height: 0; width: 100%; object-fit: contain; background: var(--paper-2); }
.image-caption { border: 0; padding: 6px 12px; background: transparent; color: var(--ink-2); font: 12px var(--prose); outline: none; }
.image-caption:focus { color: var(--ink); }
`;

export default function (host) {
  let img;
  let cap;

  const body = () => host.read(host.pin.note);
  const write = () => {
    const [name = '', path = ''] = lines(body());
    host.write(cap.value ? `${name}\n${path}\n\n${cap.value}` : `${name}\n${path}`);
  };
  const draw = (text) => {
    const src = pathOf(text) ? `/${pathOf(text)}` : '';
    if (img.getAttribute('src') !== src) img.src = src;
    img.alt = captionOf(text) || lines(text)[0] || '';
    if (document.activeElement !== cap && cap.value !== captionOf(text)) cap.value = captionOf(text);
  };

  return {
    mount(box, note) {
      if (!document.getElementById('type-image')) {
        const style = document.createElement('style');
        style.id = 'type-image';
        style.textContent = CSS;
        document.head.append(style);
      }
      box.classList.add('image');
      img = document.createElement('img');
      img.className = 'image-pic';
      img.draggable = false;
      cap = document.createElement('input');
      cap.className = 'image-caption';
      cap.placeholder = 'caption';
      cap.spellcheck = false;
      cap.addEventListener('input', write);
      box.append(img, cap);
      draw(note.body);
    },
    focus: () => cap.focus(),
    blur: () => cap.blur(),
    save: () => write(),
    onPatch: (note) => draw(note.body),
  };
}
