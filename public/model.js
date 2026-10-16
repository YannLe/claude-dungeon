// Claude Dungeon — modèle pur et déterministe.
// Transforme la liste d'événements d'une session en état lisible : quête, narration,
// objectifs, compagnons (sous-agents), carte des dossiers et chronique en phases.
// Aucune horloge, aucun hasard : rejouer les mêmes événements donne le même état.
// Chargé tel quel par le navigateur (window.DungeonModel) et par Node (require).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DungeonModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const IDLE_GAP_MS = 8000; // au-delà, une phase se ferme même si l'action ne change pas
  const ERR_DMG = 7;
  const MAX_JOURNAL = 1500;
  const MAX_ITEMS = 300;

  // ================== utilitaires ==================

  const basename = (p) => (p || '').split('/').filter(Boolean).pop() || p || '';
  const dirOf = (k) => { const i = k.lastIndexOf('/'); return i < 0 ? '.' : k.slice(0, i); };
  const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
  const oneLine = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const pl = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const levelOf = (xp) => 1 + Math.floor(Math.sqrt(xp / 15));

  function normPath(p) {
    const out = [];
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return '/' + out.join('/');
  }

  function guessHome(cwd) {
    const m = (cwd || '').match(/^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/);
    return m ? m[1] : null;
  }

  // Situe un chemin sur la carte. Les clés sont relatives au projet ;
  // ce qui est hors du projet vit sous la branche « ↗ ».
  function locate(S, p, base) {
    if (!p || typeof p !== 'string') return null;
    p = p.trim();
    if (!p || p === '-' || p.startsWith('$')) return null;
    if (p === '~' || p.startsWith('~/')) { if (!S.home) return null; p = S.home + p.slice(1); }
    if (!p.startsWith('/')) { if (!S.cwd && !base) return null; p = (base || S.cwd) + '/' + p; }
    p = normPath(p);
    const cwd = S.cwd || '';
    // fichiers internes de Claude (mémoire, résultats d'outils, brouillons) : hors carte
    const inClaude = S.home && (p === S.home + '/.claude' || p.startsWith(S.home + '/.claude/'));
    if ((inClaude && !(cwd + '/').startsWith(S.home + '/.claude/')) || /^\/tmp\/claude-\d+(\/|$)/.test(p) || p.startsWith('/dev/') || p.startsWith('/proc/')) return { internal: true };
    if (cwd && p === cwd) return { key: '.' };
    if (cwd && p.startsWith(cwd + '/')) return { key: p.slice(cwd.length + 1) };
    const parent = cwd ? cwd.slice(0, cwd.lastIndexOf('/')) : '';
    if (parent && parent.split('/').length > 3 && p.startsWith(parent + '/')) return { key: '↗/' + p.slice(parent.length + 1), external: true };
    if (S.home && p.startsWith(S.home + '/')) return { key: '↗/~/' + p.slice(S.home.length + 1), external: true };
    if (p === '/') return { key: '↗' };
    return { key: '↗' + p, external: true };
  }

  function displayKey(key) {
    if (key === '↗') return '↗ hors du projet';
    return key.startsWith('↗/') ? '↗ ' + key.slice(2) : key;
  }

  function dirLabel(S, key) {
    if (key === '.') return S.project;
    return displayKey(key);
  }

  // ================== Bash : lecture ou sort ? ==================

  // Découpe une commande shell en commandes simples (sans exécuter quoi que ce soit).
  function tokenizeShell(cmd) {
    const segs = [];
    let cur = [], tok = '', has = false, q = null;
    const push = () => { if (has) cur.push(tok); tok = ''; has = false; };
    const cut = (sep) => { push(); segs.push({ tokens: cur, sep }); cur = []; };
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (q) {
        if (c === q) q = null;
        else if (c === '\\' && q === '"' && i + 1 < cmd.length) tok += cmd[++i];
        else tok += c;
        continue;
      }
      if (c === "'" || c === '"') { q = c; has = true; continue; }
      if (c === '\\' && i + 1 < cmd.length) { if (cmd[i + 1] !== '\n') tok += cmd[i + 1]; i++; has = has || cmd[i] !== '\n'; continue; }
      if (c === ' ' || c === '\t') { push(); continue; }
      if (c === '#' && !has) { while (i < cmd.length && cmd[i] !== '\n') i++; i--; continue; }
      if (c === '\n' || c === ';') { cut(';'); continue; }
      if (c === '&' && cmd[i + 1] === '&') { cut('&&'); i++; continue; }
      if (c === '|' && cmd[i + 1] === '|') { cut('||'); i++; continue; }
      if (c === '|') { cut('|'); continue; }
      if (c === '&' && cmd[i + 1] !== '>') { cut('&'); continue; }
      if (c === '<' && cmd[i + 1] === '<') {
        // heredoc : on saute le corps, qui n'est pas une suite de commandes
        push();
        let j = i + 2;
        if (cmd[j] === '-' || cmd[j] === '<') j++;
        while (cmd[j] === ' ') j++;
        const m = cmd.slice(j).match(/^(['"]?)([\w.-]+)\1/);
        if (!m) { i = j - 1; continue; }
        const delim = m[2];
        const nl = cmd.indexOf('\n', j);
        // le reste de la ligne (ex. « > fichier ») est encore de la commande
        const restOfLine = nl < 0 ? '' : cmd.slice(j + m[0].length, nl);
        if (/>/.test(restOfLine)) cur.push({ redir: '>' }, '(heredoc)');
        if (nl < 0) { i = cmd.length; continue; }
        const endRe = new RegExp(`\\n\\s*${delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\n|$)`, 'g');
        endRe.lastIndex = nl;
        const e = endRe.exec(cmd);
        i = e ? e.index + e[0].length - 1 : cmd.length;
        cut(';');
        continue;
      }
      if (c === '>' || c === '<') {
        if (/^\d$/.test(tok)) { tok = ''; has = false; } else push();
        let op = c;
        while (cmd[i + 1] === '>' || cmd[i + 1] === '&') op += cmd[++i];
        cur.push({ redir: op });
        continue;
      }
      if (c === '$' && cmd[i + 1] === '(') {
        // substitution : on la saute, elle ne change pas la nature de la commande
        let depth = 0;
        for (; i < cmd.length; i++) { if (cmd[i] === '(') depth++; else if (cmd[i] === ')' && --depth === 0) break; }
        tok += '$()'; has = true;
        continue;
      }
      tok += c; has = true;
    }
    push();
    if (cur.length) segs.push({ tokens: cur, sep: null });
    // redirections : « > fichier » écrit, « < fichier » lit
    for (const s of segs) {
      const toks = [];
      s.writes = false; s.reads = [];
      for (let k = 0; k < s.tokens.length; k++) {
        const t = s.tokens[k];
        if (t && typeof t === 'object') {
          const target = s.tokens[k + 1];
          k++;
          if (typeof target !== 'string') continue;
          if (t.redir.startsWith('>') && target !== '/dev/null' && !/^&?\d$/.test(target) && !t.redir.endsWith('&')) s.writes = true;
          if (t.redir === '<') s.reads.push(target);
          continue;
        }
        toks.push(t);
      }
      s.tokens = toks;
    }
    return segs;
  }

  const READ_VERBS = new Set(('cat head tail less more nl wc sed awk gawk grep egrep fgrep rg ag ack ls ll tree find fd stat file du df ' +
    'jq yq diff cmp column sort uniq cut tr basename dirname realpath readlink pwd echo printf which type whereis command ' +
    'env printenv date id whoami hostname uname cd true false test [ md5sum sha1sum sha256sum strings hexdump od xxd bat ' +
    'tac rev fold fmt expand look comm join paste seq sleep wait').split(' '));
  const FILE_VERBS = new Set('cat head tail less more nl wc stat file md5sum sha1sum sha256sum strings hexdump od xxd bat tac jq yq diff cmp column sort uniq cut sed awk gawk'.split(' '));
  const SEARCH_VERBS = new Set('grep egrep fgrep rg ag ack'.split(' '));
  const DIR_VERBS = new Set('ls ll tree du find fd'.split(' '));
  const SUB_READ = { docker: new Set(['ps', 'logs', 'inspect', 'images', 'version', 'info', 'stats', 'top']), ddev: new Set(['describe', 'logs', 'status', 'list', 'version']), composer: new Set(['show', 'outdated', 'why', 'why-not', 'validate', 'licenses', 'depends']), npm: new Set(['ls', 'list', 'view', 'outdated', 'why', 'explain']) };
  const GIT_READ = new Set('status log diff show blame branch rev-parse ls-files ls-tree grep remote describe shortlog reflog fetch cat-file config merge-base rev-list name-rev whatchanged'.split(' '));
  const TEST_RE = /(?:^|[\s/;&|'"(])(phpunit|pest|paratest|jest|vitest|mocha|pytest|tox|playwright|cypress|rspec|behat|codecept(?:ion)?|phpstan|psalm|php-cs-fixer|phpcs|eslint|stylelint|tsc|ruff|mypy|go (?:test|vet)|cargo (?:test|clippy)|mvn (?:test|verify)|gradlew? test|(?:npm|pnpm|yarn|bun) (?:run )?(?:test|lint|typecheck|check)|composer (?:run(?:-script)? )?(?:test|tests|csi|qa|lint|phpstan|check)|make (?:test|check|lint|qa))(?=$|[\s;&|'")])/;
  const CONTROL_START = new Set(['for', 'while', 'until', 'case', 'select', 'function', 'done', 'esac', 'fi', '}', ')']);
  const CONTROL_PREFIX = new Set(['do', 'then', 'else', 'elif', 'if', '!', '{', '(', 'time', '[[', ']]']);

  // Retire les préfixes qui ne disent rien de la nature de la commande.
  function stripPrefix(tokens) {
    const t = tokens.slice();
    for (;;) {
      if (!t.length) return t;
      const v = t[0];
      if (/^[A-Za-z_][\w]*=/.test(v)) { t.shift(); continue; }
      if (['sudo', 'time', 'nice', 'nohup', 'builtin', 'exec', 'env', 'npx', 'bunx', 'pnpx', 'stdbuf'].includes(v)) { t.shift(); while (t[0] && t[0].startsWith('-')) t.shift(); continue; }
      if (CONTROL_PREFIX.has(v)) { t.shift(); continue; }
      if (v.startsWith('(') && v.length > 1) { t[0] = v.slice(1); continue; }
      if (v === 'timeout') { t.shift(); while (t[0] && t[0].startsWith('-')) t.shift(); t.shift(); continue; }
      if (v === 'ddev' && (t[1] === 'exec' || t[1] === 'ssh')) { t.splice(0, 2); while (t[0] && t[0].startsWith('-')) t.shift(); continue; }
      if (v === 'docker' && t[1] === 'compose' && t[2] === 'exec') { t.splice(0, 3); while (t[0] && t[0].startsWith('-')) t.shift(); t.shift(); continue; }
      if ((v === 'docker' || v === 'podman') && t[1] === 'exec') { t.splice(0, 2); while (t[0] && t[0].startsWith('-')) t.shift(); t.shift(); continue; }
      return t;
    }
  }

  const looksNumeric = (s) => /^[\d,.:$+-]+[pdq]?$/.test(s);
  const looksPath = (s) => /^[~.\w\/@+-][\w.\/@+~*?{}\[\]-]*$/.test(s) && !looksNumeric(s);

  function fileArgs(verb, args) {
    const out = [];
    let skipScript = verb === 'sed' || verb === 'awk' || verb === 'gawk' || verb === 'jq' || verb === 'yq';
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('-')) {
        if (/^-(n|c|e|f|d|k|t|F|v)$/.test(a) && verb !== 'cat' && verb !== 'ls') {
          if ((verb === 'sed' && a === '-e') || (verb === 'awk' && a === '-f')) skipScript = false;
          i++;
        }
        continue;
      }
      if (skipScript) { skipScript = false; continue; }
      if (looksPath(a)) out.push(a);
    }
    return out;
  }

  function searchArgs(args) {
    const out = [];
    let pattern = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') continue;
      if (a.startsWith('-')) {
        if (/^-(e|f)$/.test(a) || a === '--regexp') { pattern = false; i++; }
        else if (/^-(A|B|C|m|g|t|T)$/.test(a) || a === '--glob' || a === '--type' || a === '--include' || a === '--exclude') i++;
        continue;
      }
      if (pattern) { pattern = false; continue; }
      if (looksPath(a)) out.push(a);
    }
    return out;
  }

  function dirArgs(verb, args) {
    const out = [];
    for (const a of args) {
      if (verb === 'find' && /^[-(!]/.test(a)) break;
      if (a.startsWith('-')) continue;
      if (looksPath(a)) out.push(a);
    }
    return out;
  }

  // Analyse une commande : famille (explore / test / spell) et fichiers ou dossiers visés.
  function parseBash(cmd, S, depth = 0) {
    const res = { family: 'explore', files: [], dirs: [], verbs: [] };
    if (!cmd) { res.family = 'spell'; return res; }
    let base = S.cwd;
    let readOnly = true;
    const segs = tokenizeShell(cmd);
    let prevSep = null;
    for (const seg of segs) {
      const piped = prevSep === '|';
      prevSep = seg.sep;
      let t = stripPrefix(seg.tokens);
      if (!t.length) continue;
      let verb = basename(t[0]);
      if (CONTROL_START.has(verb)) continue;
      // commande passée entière entre guillemets (ddev exec '…', bash -c '…')
      const quoted = t.length === 1 && /\s/.test(t[0]) ? t[0] : ((verb === 'bash' || verb === 'sh' || verb === 'zsh') && t[1] === '-c' ? t[2] : null);
      if (quoted && depth < 2) {
        const inner = parseBash(quoted, S, depth + 1);
        if (inner.family !== 'explore') readOnly = false;
        if (inner.family === 'test') res.family = 'test';
        res.files.push(...inner.files); res.dirs.push(...inner.dirs);
        continue;
      }
      if (verb === 'xargs') { t = t.slice(1); while (t[0] && t[0].startsWith('-')) t.shift(); verb = basename(t[0] || ''); }
      res.verbs.push(verb);
      if (TEST_RE.test(' ' + t.join(' ') + ' ')) res.family = 'test';
      if (seg.writes) readOnly = false;
      if (verb === 'cd') {
        if (t[1] && !t[1].startsWith('-')) base = t[1].startsWith('/') ? normPath(t[1]) : (t[1].startsWith('~') && S.home ? normPath(S.home + t[1].slice(1)) : normPath(base + '/' + t[1]));
        continue;
      }
      if (SUB_READ[verb]) {
        const sub = t.slice(1).find((x) => !x.startsWith('-'));
        if (!SUB_READ[verb].has(sub)) readOnly = false;
        continue;
      }
      if (verb === 'git') {
        const sub = t.find((x, i) => i > 0 && !x.startsWith('-') && !(t[i - 1] === '-C' || t[i - 1] === '-c'));
        if (!GIT_READ.has(sub)) readOnly = false;
        continue;
      }
      if (verb === 'sed' && t.some((x) => /^-i/.test(x) || x === '--in-place')) readOnly = false;
      else if ((verb === 'find') && t.some((x) => x === '-delete' || x === '-exec' || x === '-execdir')) {
        const ex = t[t.indexOf('-exec') + 1] || t[t.indexOf('-execdir') + 1] || '';
        if (t.includes('-delete') || !READ_VERBS.has(basename(ex))) readOnly = false;
      } else if (!READ_VERBS.has(verb)) readOnly = false;
      const args = t.slice(1);
      const add = (list, a) => list.push({ raw: a, base });
      for (const r of seg.reads) add(res.files, r);
      if (SEARCH_VERBS.has(verb)) {
        const paths = searchArgs(args);
        for (const a of paths) add(/\.[\w]{1,8}$/.test(basename(a)) ? res.files : res.dirs, a);
        if (!paths.length && !piped && args.some((a) => a === '-r' || a === '-R' || /^-\w*[rR]/.test(a) || verb !== 'grep')) add(res.dirs, base);
      } else if (DIR_VERBS.has(verb)) {
        const paths = verb === 'fd' ? args.filter((x) => !x.startsWith('-')).slice(1) : dirArgs(verb, args);
        for (const a of paths) add(/\.[\w]{1,8}$/.test(basename(a)) && !a.includes('*') ? res.files : res.dirs, a);
        if (!paths.length) add(res.dirs, base);
      } else if (FILE_VERBS.has(verb)) for (const a of fileArgs(verb, args)) add(a.includes('*') ? res.dirs : res.files, a);
    }
    if (res.family !== 'test' && !readOnly) res.family = 'spell';
    if (depth > 0) return res;
    // résolution des chemins
    const files = [], dirs = [];
    const seen = new Set();
    for (const f of res.files) {
      if (files.length >= 10) break;
      const loc = locate(S, f.raw, f.base || undefined);
      if (!loc || loc.internal || !loc.key || seen.has(loc.key) || loc.key === '.') continue;
      seen.add(loc.key); files.push(loc.key);
    }
    for (const d of res.dirs) {
      if (dirs.length >= 6) break;
      let raw = d.raw;
      const w = raw.search(/[*?{[]/);
      if (w >= 0) raw = raw.slice(0, w).replace(/\/[^/]*$/, '') || '.';
      const loc = locate(S, raw, d.base || undefined);
      if (!loc || loc.internal || !loc.key || seen.has(loc.key)) continue;
      seen.add(loc.key); dirs.push(loc.key);
    }
    return { family: res.family, files, dirs, verbs: res.verbs };
  }

  // ================== familles d'outils ==================

  const FAMILY = {
    explore: { icon: '🔍', imp: 2 },
    forge: { icon: '⚒', imp: 1 },
    test: { icon: '🧪', imp: 2 },
    spell: { icon: '🔮', imp: 2 },
    oracle: { icon: '🦉', imp: 2 },
    artefact: { icon: '🗝', imp: 2 },
    meta: { icon: '📚', imp: 2 },
  };

  function toolFamily(tool) {
    if (/^(Read|NotebookRead|Grep|Glob|LS)$/.test(tool)) return 'explore';
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'forge';
    if (tool === 'Bash') return 'bash';
    if (tool === 'WebFetch' || tool === 'WebSearch') return 'oracle';
    if (tool.startsWith('mcp__')) return 'artefact';
    if (tool === 'Agent' || tool === 'Task') return 'companion';
    if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate') return 'todo';
    if (/^(AskUserQuestion|ExitPlanMode)$/.test(tool)) return 'ask';
    if (/^(BashOutput|KillShell|KillBash|Monitor)$/.test(tool)) return 'spell';
    return 'meta';
  }

  // ================== session ==================

  function createSession(id, cwd) {
    const S = {
      id, cwd: cwd || '', project: basename(cwd) || '?', home: guessHome(cwd),
      firstAt: null, lastAt: null, rev: 0, mapRev: 0,
      quest: null, questT: null, narration: null,
      objectives: [],
      waiting: null, stopped: false, ended: false,
      stats: { reads: 0, searches: 0, forged: 0, created: 0, spells: 0, tests: 0, fails: 0, xp: 0, hp: 100, level: 1, quests: 0, objectives: 0 },
      questStats: null,
      dirs: new Map(), files: new Map(),
      launches: [], companions: new Map(),
      journal: [], phase: null, seq: 0,
      pending: new Map(), // useId -> { entry, item }
      heroAt: null, // dernière cible du héros (clé de fichier ou de dossier)
    };
    S.dirs.set('.', { key: '.', parent: null, files: [], children: [] });
    return S;
  }

  function setCwd(S, cwd) {
    if (!cwd || S.cwd === cwd) return;
    S.cwd = cwd; S.project = basename(cwd) || '?'; S.home = guessHome(cwd);
  }

  function ensureDir(S, key) {
    if (S.dirs.has(key)) return S.dirs.get(key);
    const parentKey = key === '↗' ? '.' : (key.startsWith('↗/') && !key.slice(2).includes('/') ? '↗' : dirOf(key));
    const parent = ensureDir(S, parentKey);
    const d = { key, parent: parentKey, files: [], children: [] };
    S.dirs.set(key, d);
    parent.children.push(key);
    S.mapRev++;
    return d;
  }

  const RANK = { seen: 0, edited: 1, created: 2 };
  function touchFile(S, key, state) {
    let f = S.files.get(key);
    if (!f) {
      const dir = key.startsWith('↗/') && !key.slice(2).includes('/') ? '↗' : dirOf(key);
      f = { key, name: basename(key), dir, state: 'seen', reads: 0, edits: 0 };
      S.files.set(key, f);
      ensureDir(S, dir).files.push(key);
      S.mapRev++;
    }
    if (state && RANK[state] > RANK[f.state]) { f.state = state; S.mapRev++; }
    return f;
  }

  function touchDir(S, key) {
    if (!key) return null;
    return ensureDir(S, key);
  }

  // ================== journal ==================

  function addEntry(S, e) {
    e.id = ++S.seq;
    e.rev = 1;
    S.journal.push(e);
    if (S.journal.length > MAX_JOURNAL) S.journal.splice(0, S.journal.length - MAX_JOURNAL);
    return e;
  }
  const bump = (e) => { e.rev++; };

  function closePhase(S) {
    if (S.phase) { S.phase.open = false; bump(S.phase); S.phase = null; }
  }

  function commonDir(keys) {
    if (!keys.length) return null;
    let parts = dirOf(keys[0]).split('/');
    for (const k of keys.slice(1)) {
      const p = dirOf(k).split('/');
      let i = 0;
      while (i < parts.length && i < p.length && parts[i] === p[i]) i++;
      parts = parts.slice(0, i);
    }
    const d = parts.join('/');
    return d && d !== '.' ? d : '.';
  }

  function failText(n) { return n ? `, ${pl(n, 'échec', 'échecs')}` : ''; }

  // Titre d'une phase à partir de son contenu : c'est ce que lit l'utilisateur.
  function describePhase(S, e) {
    const fam = e.fam;
    const keys = [...e.files];
    const place = (list) => { const d = commonDir(list); return d && d !== '.' ? dirLabel(S, d) : null; };
    if (fam === 'explore') {
      const where = place(keys.length ? keys : [...e.dirs].map((d) => d + '/x')) || 'le projet';
      const parts = [];
      if (keys.length) parts.push(`${pl(keys.length, 'fichier lu', 'fichiers lus')}`);
      if (e.searches) parts.push(pl(e.searches, 'recherche', 'recherches'));
      if (!keys.length && !e.searches && e.cmds) parts.push(pl(e.cmds, 'commande', 'commandes'));
      return `Explore ${where} — ${parts.join(', ') || 'en reconnaissance'}${failText(e.fails)}`;
    }
    if (fam === 'forge') {
      const n = e.forged.size, c = e.created.size;
      if (n === 1) return `Forge ${basename([...e.forged][0])}${c ? ' (nouveau)' : ''}${failText(e.fails)}`;
      const where = place([...e.forged]);
      return `Forge ${n} fichiers${where ? ` dans ${where}` : ''}${c ? ` (${c} créé${c > 1 ? 's' : ''})` : ''}${failText(e.fails)}`;
    }
    if (fam === 'test') {
      const last = e.items[e.items.length - 1];
      const recovered = e.fails && last && last.done && !last.err;
      return `Lance les tests (${pl(e.items.length, 'sort', 'sorts')}${failText(e.fails)})${recovered ? ' → ✔ au vert' : ''}`;
    }
    if (fam === 'spell') {
      if (e.items.length === 1) return `Lance un sort : ${short(oneLine(e.items[0].cmd || e.items[0].text), 70)}${failText(e.fails)}`;
      return `Lance ${e.items.length} sorts${failText(e.fails)}`;
    }
    if (fam === 'oracle') return `Consulte l'oracle — ${pl(e.items.length, 'recherche web', 'recherches web')}${failText(e.fails)}`;
    if (fam === 'artefact') {
      const names = [...new Set(e.items.map((i) => i.server))];
      return `Utilise ${names.length === 1 ? `l'artefact ${names[0]}` : `${names.length} artefacts`} — ${pl(e.items.length, 'action', 'actions')}${failText(e.fails)}`;
    }
    const names = [...new Set(e.items.map((i) => i.tool))].slice(0, 3).join(', ');
    return `Consulte le grimoire (${names})${failText(e.fails)}`;
  }

  function refreshPhase(S, e) {
    e.title = describePhase(S, e);
    e.imp = FAMILY[e.fam].imp === 1 || e.fails > 0 ? 1 : 2;
    bump(e);
  }

  function openPhase(S, fam, t) {
    const e = addEntry(S, {
      type: 'phase', fam, icon: FAMILY[fam].icon, t, t2: t, open: true, imp: FAMILY[fam].imp,
      items: [], files: new Set(), dirs: new Set(), forged: new Set(), created: new Set(),
      searches: 0, cmds: 0, fails: 0, more: 0,
    });
    S.phase = e;
    return e;
  }

  // ================== compagnons ==================

  function launchLabel(L) { return L.label || L.type || 'Compagnon'; }

  function newLaunch(S, info) {
    const L = { useId: info.useId || null, label: info.label || '', type: info.type || null, parent: info.parent || null, t: info.t, agentId: null, companion: null, synthetic: !!info.synthetic };
    L.entry = addEntry(S, { type: 'companion', icon: '🧝', t: info.t, t2: info.t, imp: 2, open: true, launch: L, items: [], more: 0 });
    S.launches.push(L);
    refreshCompanion(S, L);
    return L;
  }

  function companionStats(c) {
    if (!c) return '';
    const parts = [];
    if (c.reads) parts.push(`${c.reads} lus`);
    if (c.forged) parts.push(`${c.forged} forgés`);
    if (c.spells) parts.push(pl(c.spells, 'sort', 'sorts'));
    if (c.fails) parts.push(pl(c.fails, 'échec', 'échecs'));
    return parts.join(' · ');
  }

  function refreshCompanion(S, L) {
    const e = L.entry;
    const c = L.companion;
    const n = c ? c.actions : 0;
    const back = c && c.state === 'back';
    e.open = !back;
    e.title = `${back ? 'Mission accomplie' : 'En mission'} : ${short(launchLabel(L), 70)} — ${pl(n, 'action', 'actions')}`;
    e.sub = companionStats(c);
    e.text = c && c.report ? c.report : '';
    e.imp = c && c.fails ? 1 : 2;
    e.items = c ? c.items : [];
    e.more = c ? c.more : 0;
    if (c && c.t1) e.t2 = c.t1;
    bump(e);
  }

  function companionFor(S, agentId, ev) {
    let c = S.companions.get(agentId);
    if (c) return c;
    let L = S.launches.find((l) => l.agentId === agentId);
    // sinon : le plus ancien lancement pas encore attribué (lien exact corrigé à la fin de l'outil Agent)
    if (!L) {
      L = S.launches.find((l) => !l.agentId && !l.synthetic && !l.closed);
      if (L) { L.agentId = agentId; L.tentative = true; }
    }
    if (!L) { L = newLaunch(S, { label: ev.agentType || 'Compagnon', type: ev.agentType, t: ev.t, synthetic: true }); L.agentId = agentId; }
    c = { agentId, launch: L, actions: 0, reads: 0, forged: 0, spells: 0, fails: 0, state: 'out', t0: ev.t, t1: null, items: [], more: 0, report: '' };
    L.companion = c;
    S.companions.set(agentId, c);
    return c;
  }

  // Lien exact lancement → agent, connu à la fin de l'outil Agent.
  function bindLaunch(S, L, agentId) {
    if (L.agentId === agentId) { L.tentative = false; return; }
    const other = S.launches.find((l) => l !== L && l.agentId === agentId);
    const mine = L.companion;
    const theirs = S.companions.get(agentId) || null;
    if (other) {
      other.agentId = L.agentId; other.companion = mine; other.tentative = !!mine;
      if (mine) mine.launch = other;
      refreshCompanion(S, other);
    } else if (mine) {
      // l'agent supposé n'était pas le bon : il redevient orphelin
      mine.launch = newLaunch(S, { label: mine.type || 'Compagnon', t: mine.t0, synthetic: true });
      mine.launch.agentId = mine.agentId; mine.launch.companion = mine;
      refreshCompanion(S, mine.launch);
    }
    L.agentId = agentId; L.companion = theirs; L.tentative = false;
    if (theirs) theirs.launch = L;
    refreshCompanion(S, L);
  }

  function companionBack(S, c, t, report) {
    if (report) c.report = report;
    if (c.state !== 'back') { c.state = 'back'; c.t1 = t; }
    refreshCompanion(S, c.launch);
  }

  // ================== objectifs ==================

  function applyTodos(S, ev, moves) {
    const byText = ev.tool === 'TodoWrite';
    const prev = S.objectives;
    const find = (td) => prev.find((o) => (byText ? o.text === td.text : o.id === td.id));
    const next = ev.todos.map((td) => {
      const o = find(td);
      return { id: td.id, text: td.text, active: td.active, status: td.status, startT: o ? o.startT : null, doneT: o ? o.doneT : null, actions: o ? o.actions : 0, slot: o ? o.slot : null };
    });
    // place stable de chaque monstre dans l'antre
    let slot = Math.max(-1, ...prev.map((o) => o.slot ?? -1));
    for (const o of next) if (o.slot == null) o.slot = ++slot;

    const added = next.filter((o) => !find(o));
    const lines = [];
    if (added.length) {
      closePhase(S);
      const lastEntry = S.journal[S.journal.length - 1];
      const items = added.map((o) => ({ t: ev.t, icon: '👹', text: o.text }));
      if (lastEntry && lastEntry.type === 'objectives' && ev.t - lastEntry.t2 <= IDLE_GAP_MS) {
        // TaskCreate arrive un objectif à la fois : on complète l'entrée précédente
        lastEntry.items.push(...items);
        lastEntry.t2 = ev.t;
        lastEntry.title = lastEntry.fresh ? `Fixe ${pl(lastEntry.items.length, 'objectif', 'objectifs')}` : `Nouveaux objectifs (${lastEntry.items.length})`;
        bump(lastEntry);
      } else {
        const fresh = prev.length === 0;
        addEntry(S, { type: 'objectives', icon: '🗺', t: ev.t, t2: ev.t, imp: 1, fresh, title: fresh ? `Fixe ${pl(added.length, 'objectif', 'objectifs')}` : `Nouveaux objectifs (${added.length})`, items });
      }
    }
    for (const o of next) {
      const before = find(o);
      const was = before ? before.status : null;
      if (o.status === 'in_progress' && was !== 'in_progress') {
        o.startT = ev.t;
        lines.push(['⚔', `Affronte : ${o.text}`]);
        moves.push({ actor: 'hero', act: 'engage', obj: o.id });
      }
      if (o.status === 'completed' && was !== 'completed') {
        o.doneT = ev.t;
        S.stats.objectives++;
        gain(S, 20);
        lines.push(['🏆', `Objectif vaincu : ${o.text}`]);
        moves.push({ actor: 'hero', act: 'victory', obj: o.id, text: o.text });
      }
    }
    for (const o of prev) {
      if (!next.some((n) => (byText ? n.text === o.text : n.id === o.id)) && o.status !== 'completed') lines.push(['✖', `Abandonne : ${o.text}`, 2]);
    }
    if (lines.length) closePhase(S);
    for (const [icon, title, imp] of lines) addEntry(S, { type: 'objective', icon, t: ev.t, imp: imp || 1, title });
    S.objectives = next;
  }

  function gain(S, n) {
    S.stats.xp += n;
    const lvl = levelOf(S.stats.xp);
    if (lvl > S.stats.level) {
      S.stats.level = lvl;
      addEntry(S, { type: 'level', icon: '⭐', t: S.lastAt, imp: 2, title: `Le héros passe niveau ${lvl}` });
      return true;
    }
    return false;
  }

  // ================== réduction ==================

  function itemFor(S, ev, fam, info) {
    const t = ev.tool;
    const it = { t: ev.t, useId: ev.useId || null, tool: t, done: false, err: false };
    if (t === 'Read' || t === 'NotebookRead') Object.assign(it, { icon: '👁', text: info.key ? displayKey(info.key) : (ev.path || '?') });
    else if (t === 'Grep') Object.assign(it, { icon: '🔎', text: `« ${short(ev.detail, 60)} » dans ${info.dir ? dirLabel(S, info.dir) : 'le projet'}` });
    else if (t === 'Glob') Object.assign(it, { icon: '🧭', text: `${short(ev.detail, 60)} dans ${info.dir ? dirLabel(S, info.dir) : 'le projet'}` });
    else if (fam === 'forge') Object.assign(it, { icon: info.created ? '✨' : '⚒', text: info.key ? displayKey(info.key) : (ev.path || '?') });
    else if (t === 'Bash') Object.assign(it, { icon: fam === 'explore' ? '📜' : fam === 'test' ? '🧪' : '🔮', text: short(oneLine(ev.detail), 200), cmd: ev.detail });
    else if (fam === 'oracle') Object.assign(it, { icon: '🦉', text: short(ev.detail, 120) });
    else if (fam === 'artefact') Object.assign(it, { icon: '🗝', text: ev.detail || t, server: (t.split('__')[1] || t).replace(/^claude_ai_/, '').replace(/^claude-in-/, '') });
    else Object.assign(it, { icon: '⚙', text: `${t}${ev.detail ? ` ${short(ev.detail, 80)}` : ''}` });
    return it;
  }

  function pushItem(holder, it) {
    holder.items.push(it);
    if (holder.items.length > MAX_ITEMS) { holder.items.shift(); holder.more = (holder.more || 0) + 1; }
  }

  // Interprète un appel d'outil : mise à jour de la carte et des stats, cible du déplacement.
  function interpretTool(S, ev) {
    const t = ev.tool || '';
    let fam = toolFamily(t);
    const info = { key: null, dir: null, created: false, files: [], dirs: [] };
    let move = null;
    if (fam === 'explore') {
      if (t === 'Grep' || t === 'Glob') {
        const loc = locate(S, ev.path || '.');
        if (loc && !loc.internal) {
          const isFile = /\.[\w]{1,8}$/.test(basename(loc.key)) && t === 'Grep';
          if (isFile) { info.key = loc.key; touchFile(S, loc.key); } else { info.dir = loc.key; touchDir(S, loc.key); }
        }
        S.stats.searches++;
        move = info.key ? { act: 'read', file: info.key } : { act: 'scan', dir: info.dir || '.' };
      } else {
        const loc = locate(S, ev.path);
        if (loc && loc.internal) return { fam, internal: true };
        if (loc && loc.key && loc.key !== '.') { info.key = loc.key; const f = touchFile(S, loc.key); f.reads++; }
        S.stats.reads++;
        move = info.key ? { act: 'read', file: info.key } : null;
      }
    } else if (fam === 'forge') {
      const loc = locate(S, ev.path);
      if (loc && loc.internal) return { fam, internal: true };
      if (loc && loc.key) {
        info.key = loc.key;
        const fresh = !S.files.has(loc.key);
        info.created = t === 'Write' && fresh;
        const f = touchFile(S, loc.key, info.created ? 'created' : 'edited');
        f.edits++;
      }
      S.stats.forged++;
      if (info.created) S.stats.created++;
      move = info.key ? { act: info.created ? 'create' : 'forge', file: info.key } : null;
    } else if (fam === 'bash') {
      const b = parseBash(ev.detail || '', S);
      fam = b.family;
      for (const k of b.files) { const f = touchFile(S, k); f.reads++; }
      for (const d of b.dirs) touchDir(S, d);
      info.files = b.files; info.dirs = b.dirs;
      if (fam === 'explore') {
        S.stats.reads += b.files.length;
        if (!b.files.length && !b.dirs.length) S.stats.searches++;
        move = b.files.length ? { act: 'read', file: b.files[0] } : b.dirs.length ? { act: 'scan', dir: b.dirs[0] } : null;
      } else {
        S.stats.spells++;
        if (fam === 'test') S.stats.tests++;
        move = { act: fam === 'test' ? 'test' : 'spell', text: short(oneLine(ev.detail), 46), file: b.files[0], dir: b.files[0] ? undefined : b.dirs[0] };
      }
    } else if (fam === 'oracle') move = { act: 'cast', text: '🦉 ' + short(ev.detail, 40) };
    else if (fam === 'artefact') move = { act: 'cast', text: '🗝 ' + short(ev.detail, 40) };
    else if (fam === 'meta') move = null;
    return { fam, info, move };
  }

  function recordInPhase(S, e, ev, fam, info) {
    const it = itemFor(S, ev, fam, info);
    pushItem(e, it);
    e.t2 = ev.t;
    if (info.key) (fam === 'forge' ? e.forged : e.files).add(info.key);
    if (info.created && info.key) e.created.add(info.key);
    for (const k of info.files || []) e.files.add(k);
    for (const d of info.dirs || []) e.dirs.add(d);
    if (info.dir) e.dirs.add(info.dir);
    if (ev.tool === 'Grep' || ev.tool === 'Glob') e.searches++;
    if (ev.tool === 'Bash') e.cmds++;
    if (ev.useId) {
      S.pending.set(ev.useId, { entry: e, item: it });
      if (S.pending.size > 500) S.pending.delete(S.pending.keys().next().value);
    }
    refreshPhase(S, e);
    return it;
  }

  function clearWaiting(S, kinds) {
    if (S.waiting && (!kinds || kinds.includes(S.waiting.kind))) S.waiting = null;
  }

  function onObjectiveAction(S) {
    for (const o of S.objectives) if (o.status === 'in_progress') o.actions++;
  }

  // Applique un événement. Retourne les déplacements à animer (le rendu en fait ce qu'il veut).
  // Messages de Claude Code traduits pour le journal.
  function frenchNotice(msg) {
    let m = msg.match(/^Claude needs your permission to use (.+)$/i);
    if (m) return `Attend ta permission pour ${m[1]}`;
    if (/^Claude needs your permission/i.test(msg)) return 'Attend ta permission';
    if (/waiting for your input/i.test(msg)) return 'Attend ta réponse';
    return msg;
  }

  function reduce(S, ev) {
    const moves = [];
    // compatibilité : anciens retours de sous-agents enregistrés comme prompts
    if (ev.kind === 'prompt' && /^\s*<agent-message\s+from="/.test(ev.detail || '')) {
      ev = Object.assign({}, ev, { kind: 'handback', agentId: (ev.detail.match(/from="([^"]+)"/) || [])[1], detail: '' });
    }
    if (S.firstAt == null) S.firstAt = ev.t;
    S.lastAt = ev.t;
    S.rev++;
    const main = !ev.agent;

    switch (ev.kind) {
      case 'session':
        S.ended = false;
        addEntry(S, { type: 'session', icon: '🚪', t: ev.t, imp: 2, title: `Le héros entre dans le donjon${ev.detail ? ` (${ev.detail})` : ''}` });
        break;

      case 'session-end':
        closePhase(S);
        S.ended = true; S.waiting = null;
        addEntry(S, { type: 'session', icon: '🚪', t: ev.t, imp: 2, title: 'Le héros quitte le donjon' });
        break;

      case 'prompt':
        closePhase(S);
        S.quest = ev.detail || ''; S.questT = ev.t; S.stopped = false; S.waiting = null;
        S.questStats = { t0: ev.t, forged: new Set(), fails: 0, actions: 0 };
        addEntry(S, { type: 'prompt', icon: '📜', t: ev.t, imp: 1, title: 'Nouvelle quête', text: ev.detail || '' });
        break;

      case 'sysprompt':
        S.stopped = false;
        addEntry(S, { type: 'system', icon: '🔔', t: ev.t, imp: 2, title: short(ev.detail || 'Notification', 160) });
        break;

      case 'handback': {
        S.stopped = false;
        const id = ev.agentId;
        if (id && (S.companions.has(id) || S.launches.some((l) => l.agentId === id))) {
          const c = companionFor(S, id, ev);
          companionBack(S, c, ev.t, ev.detail);
          moves.push({ actor: id, act: 'return' });
        }
        break;
      }

      case 'say':
        if (ev.sidechain) break;
        closePhase(S);
        S.narration = { text: ev.detail || '', t: ev.t };
        addEntry(S, { type: 'say', icon: '💬', t: ev.t, imp: 1, text: ev.detail || '' });
        moves.push({ actor: 'hero', act: 'say' });
        break;

      case 'chronicle':
        addEntry(S, { type: 'chronicle', icon: '📖', t: ev.t, imp: 1, title: 'Chronique de la quête', text: ev.detail || '' });
        break;

      case 'notify': {
        const msg = frenchNotice(ev.detail || 'Le héros attend tes ordres');
        const kind = ev.ntype === 'permission_prompt' || /permission/i.test(msg) ? 'permission' : 'input';
        // la demande de permission a déjà été annoncée par le hook PermissionRequest
        if (kind === 'permission' && S.waiting && S.waiting.kind === 'permission' && ev.t - S.waiting.t < 5000) break;
        closePhase(S);
        S.waiting = { kind, text: msg, t: ev.t };
        addEntry(S, { type: 'wait', icon: kind === 'permission' ? '✋' : '⏳', t: ev.t, imp: 1, title: msg, waitKind: kind });
        moves.push({ actor: 'hero', act: 'wait' });
        break;
      }

      case 'permission': {
        closePhase(S);
        const what = `${ev.tool || 'outil'}${ev.detail ? ` : ${short(oneLine(ev.detail), 120)}` : ''}`;
        S.waiting = { kind: 'permission', text: `Demande la permission — ${what}`, t: ev.t, useId: ev.useId || null };
        addEntry(S, { type: 'wait', icon: '✋', t: ev.t, imp: 1, title: `Demande la permission — ${what}`, waitKind: 'permission' });
        moves.push({ actor: ev.agent || 'hero', act: 'wait' });
        break;
      }

      case 'stop': {
        if (!main) break;
        closePhase(S);
        clearWaiting(S, ['permission']);
        S.stopped = true;
        S.stats.hp = Math.min(100, S.stats.hp + 10);
        S.stats.quests++;
        const q = S.questStats;
        const parts = [];
        if (q) {
          if (q.forged.size) parts.push(pl(q.forged.size, 'fichier forgé', 'fichiers forgés'));
          if (q.actions) parts.push(pl(q.actions, 'action', 'actions'));
          if (q.fails) parts.push(pl(q.fails, 'échec', 'échecs'));
          const d = Math.round((ev.t - q.t0) / 1000);
          if (d > 0) parts.push(d >= 60 ? `${Math.floor(d / 60)} min ${String(d % 60).padStart(2, '0')}` : `${d} s`);
        }
        addEntry(S, { type: 'stop', icon: '🏁', t: ev.t, imp: 1, title: 'Quête accomplie, le héros se repose', sub: parts.join(' · ') });
        moves.push({ actor: 'hero', act: 'rest' });
        break;
      }

      case 'subagent-stop': {
        const id = ev.agent;
        // beaucoup d'agents internes s'arrêtent sans avoir rien fait : on les ignore
        if (!id || !S.companions.has(id)) break;
        companionBack(S, S.companions.get(id), ev.t);
        moves.push({ actor: id, act: 'return' });
        break;
      }

      case 'tool-start': {
        const t = ev.tool || '';
        const fam0 = toolFamily(t);
        if (fam0 === 'todo') break;
        if (main) { clearWaiting(S); S.stopped = false; }
        if (S.questStats) S.questStats.actions++;
        onObjectiveAction(S);

        if (fam0 === 'companion') {
          if (main) closePhase(S);
          const L = newLaunch(S, { useId: ev.useId, label: ev.detail, type: ev.subtype, parent: ev.agent, t: ev.t });
          if (ev.useId) S.pending.set(ev.useId, { launch: L });
          moves.push({ actor: ev.agent || 'hero', act: 'summon', text: short(launchLabel(L), 22) });
          gain(S, 3);
          break;
        }
        if (fam0 === 'ask') {
          if (!main) break;
          closePhase(S);
          const title = t === 'ExitPlanMode' ? 'Te soumet un plan' : `Te pose une question${ev.detail ? ` : ${short(ev.detail, 140)}` : ''}`;
          S.waiting = { kind: 'input', text: title, t: ev.t, useId: ev.useId || null };
          addEntry(S, { type: 'wait', icon: '❓', t: ev.t, imp: 1, title, waitKind: 'input' });
          moves.push({ actor: 'hero', act: 'wait' });
          break;
        }

        const r = interpretTool(S, ev);
        if (r.internal) break;
        const fam = r.fam;
        if (fam === 'explore') gain(S, 1); else if (fam === 'forge') gain(S, r.info.created ? 10 : 5); else if (fam === 'spell' || fam === 'test') gain(S, 2); else gain(S, 1);
        if (fam === 'forge' && S.questStats && r.info.key) S.questStats.forged.add(r.info.key);

        if (!main) {
          const c = companionFor(S, ev.agent, ev);
          c.actions++;
          if (fam === 'explore') c.reads += Math.max(1, r.info.files.length + (r.info.key ? 1 : 0));
          else if (fam === 'forge') c.forged++;
          else if (fam === 'spell' || fam === 'test') c.spells++;
          const it = itemFor(S, ev, fam, r.info);
          pushItem(c, it);
          if (ev.useId) S.pending.set(ev.useId, { companion: c, item: it });
          refreshCompanion(S, c.launch);
          if (r.move) { moves.push({ actor: ev.agent, ...r.move }); c.at = r.move.file || r.move.dir || c.at; }
          break;
        }

        const e = S.phase;
        const sameKind = e && e.fam === fam && ev.t - e.t2 <= IDLE_GAP_MS;
        const phase = sameKind ? e : (closePhase(S), openPhase(S, fam, ev.t));
        recordInPhase(S, phase, ev, fam, r.info);
        if (r.move) { moves.push({ actor: 'hero', ...r.move }); S.heroAt = r.move.file || r.move.dir || S.heroAt; }
        break;
      }

      case 'tool-end': {
        const t = ev.tool || '';
        const fam0 = toolFamily(t);
        if (fam0 === 'todo') {
          if (ev.todos) applyTodos(S, ev, moves);
          break;
        }
        const p = ev.useId ? S.pending.get(ev.useId) : null;
        if (p) S.pending.delete(ev.useId);
        if (S.waiting && S.waiting.useId && S.waiting.useId === ev.useId) S.waiting = null;
        if (fam0 === 'ask' && main) { clearWaiting(S, ['input']); break; }

        if (fam0 === 'companion') {
          const L = (p && p.launch) || S.launches.find((l) => l.useId && l.useId === ev.useId);
          if (L && ev.agentId) bindLaunch(S, L, ev.agentId);
          if (L && !ev.async && !ev.error) {
            // agent synchrone : la fin de l'outil est son retour
            const c = L.companion || (ev.agentId ? companionFor(S, ev.agentId, ev) : null);
            if (c) { companionBack(S, c, ev.t); moves.push({ actor: c.agentId, act: 'return' }); }
            else { L.closed = true; L.entry.open = false; refreshCompanion(S, L); }
          }
          if (L && ev.error) { L.closed = true; L.entry.open = false; L.entry.imp = 1; L.entry.sub = 'échec du lancement'; bump(L.entry); }
          break;
        }

        if (fam0 === 'forge' && typeof ev.created === 'boolean') {
          const loc = locate(S, ev.path);
          if (loc && loc.key && !loc.internal) {
            const f = S.files.get(loc.key);
            if (f && ev.created && f.state !== 'created') { f.state = 'created'; S.mapRev++; }
            if (f && !ev.created && f.state === 'created' && p && p.item && p.item.icon === '✨') { f.state = 'edited'; S.mapRev++; }
            if (p && p.entry && p.entry.type === 'phase') {
              if (ev.created) p.entry.created.add(loc.key); else p.entry.created.delete(loc.key);
              if (p.item) p.item.icon = ev.created ? '✨' : '⚒';
              refreshPhase(S, p.entry);
            }
          }
        }

        if (p && p.item) { p.item.done = true; if (ev.error) p.item.err = true; }
        if (ev.error) {
          S.stats.fails++;
          if (S.questStats) S.questStats.fails++;
          S.stats.hp = Math.max(0, S.stats.hp - ERR_DMG);
          if (S.stats.hp === 0) S.stats.hp = 50; // il se relève (c'est un LLM)
          if (p && p.item) p.item.errText = ev.interrupted ? 'interrompu' : (ev.errorText || '');
          moves.push({ actor: ev.agent || 'hero', act: 'fail' });
        }
        if (p && p.entry) { if (ev.error) p.entry.fails++; refreshPhase(S, p.entry); }
        if (p && p.companion) { if (ev.error) p.companion.fails++; refreshCompanion(S, p.companion.launch); }
        break;
      }
    }
    return moves;
  }

  // Reconstruit une session complète à partir de ses événements.
  function buildSession(id, cwd, events) {
    const S = createSession(id, cwd);
    for (const ev of events) reduce(S, ev);
    return S;
  }

  // État courant pour l'affichage (le temps qui passe n'est pas dans le modèle).
  function status(S, now) {
    if (S.ended) return 'ended';
    if (S.waiting) return S.waiting.kind === 'permission' ? 'permission' : 'input';
    const idle = now - (S.lastAt || 0);
    if (S.stopped) return idle > 30 * 60 * 1000 ? 'sleep' : 'done';
    if (idle > 10 * 60 * 1000) return 'sleep';
    return 'working';
  }

  function activeCompanions(S) {
    return [...S.companions.values()].filter((c) => c.state === 'out');
  }

  return {
    IDLE_GAP_MS, createSession, setCwd, reduce, buildSession, status, activeCompanions,
    parseBash, tokenizeShell, locate, displayKey, dirLabel, toolFamily, launchLabel, levelOf,
  };
});
