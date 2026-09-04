export const type = { name: 'git-panel', title: 'Git' };

/**
 * Git is not a Type — it is a verb over the whole repo, and it lives on the
 * bridge. This is only the UI over it: branch, status, diff, message, commit.
 *
 * Everything it does is `host.fs().git([...])`, an argv array, so a commit message
 * can never become a command. It holds `fs` and nothing else, and it is
 * replaceable, because it is only a view.
 */
export default function (host) {
  let branchEl;
  let listEl;
  let diffEl;
  let messageEl;
  let statusEl;
  let picked = null;

  const git = (...args) => host.fs().git(args);

  function say(text, bad = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('bad', !!bad);
  }

  /** `git status --porcelain` — two status chars, a space, then the path. */
  function parse(stdout) {
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ state: line.slice(0, 2), path: line.slice(3).trim() }));
  }

  async function refresh() {
    say('reading…');
    try {
      const [branch, status] = await Promise.all([git('rev-parse', '--abbrev-ref', 'HEAD'), git('status', '--porcelain')]);
      // No repo at all is not the same as a clean one. Say which.
      if (status.code !== 0) {
        branchEl.textContent = '—';
        listEl.replaceChildren();
        diffEl.textContent = '';
        return say(status.stderr.trim() || `git exited ${status.code}`, true);
      }
      branchEl.textContent = branch.stdout.trim() || '(no commits yet)';

      const files = parse(status.stdout);
      listEl.replaceChildren();
      for (const file of files) {
        const row = document.createElement('button');
        row.className = file.path === picked ? 'git-file armed' : 'git-file';
        row.textContent = `${file.state} ${file.path}`;
        row.onclick = () => {
          picked = file.path;
          void show(file.path);
        };
        listEl.append(row);
      }
      say(files.length ? `${files.length} changed` : 'clean');
      if (!files.length) diffEl.textContent = '';
    } catch (err) {
      say(err && err.message ? err.message : String(err), true);
    }
  }

  async function show(path) {
    const { stdout } = await git('diff', 'HEAD', '--', path);
    diffEl.textContent = stdout || '(no diff against HEAD)';
    void refresh();
  }

  async function commit() {
    const message = messageEl.value.trim();
    if (!message) return say('a commit needs a message', true);
    say('committing…');
    try {
      const paths = picked ? [picked] : [...listEl.children].map((b) => b.textContent.slice(3));
      if (!paths.length) return say('nothing to commit', true);
      await git('add', '--', ...paths);
      const done = await git('commit', '-m', message);
      if (done.code !== 0) return say(done.stderr.trim() || done.stdout.trim(), true);
      messageEl.value = '';
      picked = null;
      diffEl.textContent = done.stdout.trim();
      await refresh();
    } catch (err) {
      say(err && err.message ? err.message : String(err), true);
    }
  }

  return {
    mount(box) {
      box.classList.add('git');

      const head = document.createElement('div');
      head.className = 'git-head';
      branchEl = document.createElement('strong');
      const reload = document.createElement('button');
      reload.textContent = '↻';
      reload.onclick = () => void refresh();
      statusEl = document.createElement('span');
      statusEl.className = 'git-status';
      head.append(branchEl, reload, statusEl);

      listEl = document.createElement('div');
      listEl.className = 'git-list';

      diffEl = document.createElement('pre');
      diffEl.className = 'git-diff';

      const foot = document.createElement('div');
      foot.className = 'git-foot';
      messageEl = document.createElement('input');
      messageEl.placeholder = 'commit message';
      messageEl.className = 'git-message';
      messageEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void commit();
      });
      const button = document.createElement('button');
      button.textContent = 'commit';
      button.onclick = () => void commit();
      foot.append(messageEl, button);

      box.append(head, listEl, diffEl, foot);
      void refresh();
    },

    reload: refresh,
  };
}
