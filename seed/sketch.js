export const type = { name: 'sketch', title: 'Sketch' };

/**
 * Sketch. Magic paper: a pen and an eraser over an SVG. The body is the name,
 * a blank line, then an Excalidraw scene — `{ type: "excalidraw", version: 2,
 * elements: [...] }` — so an agent can read or write strokes as `freedraw`
 * elements (`x, y, points: [[dx,dy],...], strokeColor, strokeWidth`; points are
 * relative to x,y, in box pixels) and Excalidraw itself can open the file.
 * Only freedraw elements are drawn here; other kinds are kept as they are.
 */

const SKELETON = { type: 'excalidraw', version: 2, elements: [] };
const CSS = `
.sketch { display: flex; flex-direction: column; background: var(--paper); }
.sketch-tools { display: flex; gap: 4px; padding: 4px; }
.sketch-tools button { font: inherit; font-size: 12px; padding: 0 6px; border: 1px solid var(--edge); background: var(--paper); color: var(--ink); border-radius: 4px; }
.sketch-tools button.on { background: var(--focus); }
.sketch-paper { flex: 1; width: 100%; touch-action: none; cursor: crosshair; }
.sketch-paper path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.sketch.erase .sketch-paper { cursor: not-allowed; }
`;

const nameOf = (body) => body.split('\n')[0] || '';
function parse(body) {
  try {
    const scene = JSON.parse(body.slice(body.indexOf('\n\n') + 2));
    if (scene && Array.isArray(scene.elements)) return scene;
  } catch {
    // not a scene yet
  }
  return null;
}
const ink = () => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#3b2f22';
const id = () => Math.random().toString(36).slice(2, 10);

export default function (host) {
  let box;
  let svg;
  let scene;
  let tool = 'pen';
  let live = null; // { el, path } while a stroke is being drawn

  const write = () => host.write(`${nameOf(host.read(host.pin.note))}\n\n${JSON.stringify(scene, null, 1)}`);

  const d = (el) => el.points.map(([px, py], i) => `${i ? 'L' : 'M'}${el.x + px} ${el.y + py}`).join(' ');
  function pathFor(el) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d(el));
    p.setAttribute('stroke', el.strokeColor || 'var(--ink)');
    p.setAttribute('stroke-width', el.strokeWidth || 2);
    p.dataset.id = el.id;
    return p;
  }
  function render() {
    svg.replaceChildren(...scene.elements.filter((e) => e.type === 'freedraw' && !e.isDeleted).map(pathFor));
  }

  const at = (e) => {
    const r = svg.getBoundingClientRect();
    return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)];
  };
  function down(e) {
    e.stopPropagation();
    if (tool === 'erase') {
      const hit = e.target.closest?.('path');
      if (!hit) return;
      scene.elements = scene.elements.filter((el) => el.id !== hit.dataset.id);
      render();
      write();
      return;
    }
    const [x, y] = at(e);
    const el = {
      id: id(), type: 'freedraw', x, y, width: 0, height: 0, angle: 0,
      strokeColor: ink(), backgroundColor: 'transparent', strokeWidth: 2, opacity: 100,
      points: [[0, 0]], pressures: [], simulatePressure: true, isDeleted: false,
    };
    live = { el, path: pathFor(el) };
    svg.append(live.path);
    svg.setPointerCapture?.(e.pointerId);
  }
  function move(e) {
    if (!live) return;
    const [x, y] = at(e);
    live.el.points.push([x - live.el.x, y - live.el.y]);
    live.path.setAttribute('d', d(live.el));
  }
  function up() {
    if (!live) return;
    const xs = live.el.points.map((p) => p[0]);
    const ys = live.el.points.map((p) => p[1]);
    live.el.width = Math.max(...xs) - Math.min(...xs);
    live.el.height = Math.max(...ys) - Math.min(...ys);
    scene.elements.push(live.el);
    live = null;
    write();
  }

  return {
    mount(el, note) {
      box = el;
      box.classList.add('sketch');
      if (!document.getElementById('type-sketch')) {
        const style = document.createElement('style');
        style.id = 'type-sketch';
        style.textContent = CSS;
        document.head.append(style);
      }
      scene = parse(note.body);
      if (!scene) {
        scene = structuredClone(SKELETON);
        write();
      }
      const tools = document.createElement('div');
      tools.className = 'sketch-tools';
      for (const t of ['pen', 'erase']) {
        const b = document.createElement('button');
        b.textContent = t;
        b.classList.toggle('on', t === tool);
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', () => {
          tool = t;
          box.classList.toggle('erase', t === 'erase');
          for (const o of tools.children) o.classList.toggle('on', o === b);
        });
        tools.append(b);
      }
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'sketch-paper');
      svg.addEventListener('pointerdown', down);
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);
      box.append(tools, svg);
      render();
    },
    onPatch(note) {
      if (live) return;
      const next = parse(note.body);
      if (next && JSON.stringify(next) !== JSON.stringify(scene)) {
        scene = next;
        render();
      }
    },
    save: () => write(),
  };
}
