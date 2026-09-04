export const type = { name: 'stub', title: 'Stub' };

/**
 * A colored box that shows its body, can emit `"ping"`, and can listen.
 * Everything it does goes through the Host — it holds no grants at all, which is
 * what makes it the honest test of the sandbox.
 */
export default function (host) {
  let text;
  let log;
  const heard = [];

  function say(line) {
    heard.unshift(line);
    heard.length = Math.min(heard.length, 4);
    if (log) log.textContent = heard.join('\n');
  }

  return {
    mount(box, note) {
      // The colour belongs to the whole pin, and the Desk owns that element.
      (box.closest('.pin') || box).style.setProperty('--hue', String(hue(note.id)));

      const head = document.createElement('div');
      head.className = 'stub-head';
      head.textContent = note.id;

      text = document.createElement('textarea');
      text.className = 'stub-body';
      text.value = note.body;
      text.spellcheck = false;
      text.addEventListener('input', () => host.write(text.value));

      const tools = document.createElement('div');
      tools.className = 'stub-tools';

      const target = document.createElement('input');
      target.placeholder = 'note id';
      target.className = 'stub-target';

      const ping = document.createElement('button');
      ping.textContent = 'ping';
      ping.onclick = () => {
        host.emit('ping', { at: Date.now() });
        say('emit ping');
      };

      const listen = document.createElement('button');
      listen.textContent = 'listen';
      listen.onclick = () => {
        const id = target.value.trim();
        if (!id) return;
        host.subscribe(id);
        say(`listening to ${id.slice(0, 9)}`);
      };

      const read = document.createElement('button');
      read.textContent = 'read';
      read.onclick = () => {
        try {
          say(`read: ${host.read(target.value.trim())}`);
        } catch (err) {
          say(err && err.message ? err.message : String(err));
        }
      };

      tools.append(target, ping, listen, read);

      log = document.createElement('pre');
      log.className = 'stub-log';

      box.append(head, text, tools, log);
    },

    focus() {
      text.focus();
    },

    blur() {
      text.blur();
      host.write(text.value);
    },

    save() {
      host.write(text.value);
    },

    onSpine(fact) {
      say(`${fact.name} from ${fact.from.slice(0, 9)}`);
    },

    onPatch(note) {
      // Another pin of this Note, or an edit from outside the app. Take it, and
      // keep the caret where it was.
      if (text.value === note.body) return;
      const from = text.selectionStart;
      const to = text.selectionEnd;
      text.value = note.body;
      if (document.activeElement === text) {
        text.setSelectionRange(Math.min(from, note.body.length), Math.min(to, note.body.length));
      }
    },
  };
}

function hue(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
