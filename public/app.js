// Claude Dungeon — rendu : royaume (une carte par projet), donjon (une salle par dossier),
// héros et compagnons qui marchent dans les couloirs, objectifs en monstres puis coffres,
// chronique en phases. Tout l'état vient de DungeonModel (model.js).
(() => {
  'use strict';
  const M = window.DungeonModel;
  const $ = (id) => document.getElementById(id);

  // ================== préférences (navigateur seulement) ==================
  const pref = {
    get(k, d) { try { const v = localStorage.getItem('dungeon.' + k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('dungeon.' + k, v); } catch { /* stockage indisponible */ } },
  };
  const SPEEDS = {
    calm: { minDur: 1000, pxPerMs: 0.55 },
    normal: { minDur: 600, pxPerMs: 0.9 },
    fast: { minDur: 300, pxPerMs: 1.6 },
  };
  let speed = SPEEDS[pref.get('speed', 'normal')] ? pref.get('speed', 'normal') : 'normal';
  let filter = pref.get('filter', 'imp') === 'all' ? 'all' : 'imp';
  const SKIP_AT = 3; // au-delà de 3 déplacements en attente, on saute les intermédiaires

  // ================== utilitaires ==================
  const basename = (p) => (p || '').split('/').filter(Boolean).pop() || p || '';
  const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const clock = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const xpFor = (lvl) => 15 * (lvl - 1) * (lvl - 1);
  const plainText = (s) => (s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  function ago(t, now) {
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 10) return "à l'instant";
    if (s < 60) return `il y a ${s} s`;
    if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
    return `il y a ${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const STATUS = {
    working: { label: 'en quête', icon: '⚔' },
    permission: { label: 'attend ta permission', icon: '✋' },
    input: { label: 'attend ta réponse', icon: '⏳' },
    done: { label: 'quête accomplie', icon: '✔' },
    sleep: { label: 'endormi', icon: '💤' },
    ended: { label: 'parti', icon: '🚪' },
  };

  // ================== sessions ==================
  /** @type {Map<string, {id:string, cwd:string, events:any[], S:any}>} */
  const sessions = new Map();
  const view = { mode: 'realm', id: null };
  let anim = null;     // animation de la session affichée
  let replay = null;   // rejeu en cours
  let firstSnapshot = true;

  function shownS() {
    if (replay) return replay.S;
    const rec = sessions.get(view.id);
    return rec ? rec.S : null;
  }

  function upsert(id, cwd) {
    let rec = sessions.get(id);
    if (!rec) { rec = { id, cwd: cwd || '', events: [], S: M.createSession(id, cwd || '') }; sessions.set(id, rec); }
    if (cwd && !rec.cwd) { rec.cwd = cwd; M.setCwd(rec.S, cwd); }
    return rec;
  }

  function objStatuses(S) { return new Map(S.objectives.map((o) => [o.id, o.status])); }

  function onSnapshot(list) {
    replay = null;
    sessions.clear();
    for (const s of list) {
      const rec = upsert(s.id, s.cwd);
      rec.events = s.events;
      rec.S = M.buildSession(s.id, s.cwd, s.events);
    }
    if (firstSnapshot) { firstSnapshot = false; chooseInitialView(); }
    else if (view.mode === 'dungeon' && !sessions.has(view.id)) setView('realm');
    else setView(view.mode, view.id, true);
  }

  function onEvent({ session, cwd, ev }) {
    const rec = upsert(session, cwd);
    rec.events.push(ev);
    const prev = objStatuses(rec.S);
    const moves = M.reduce(rec.S, ev);
    if (!replay && view.mode === 'dungeon' && view.id === rec.id && anim) enqueue(anim, moves, prev);
    if (view.mode === 'realm' && sessions.size === 1 && rec.S.firstAt === ev.t) setView('dungeon', rec.id);
    ui.dirty = true;
  }

  function onForget({ id }) {
    if (!sessions.delete(id)) return;
    if (view.id === id) setView('realm');
    ui.dirty = true;
  }

  function connect() {
    const es = new EventSource('/stream');
    es.addEventListener('open', () => $('live').classList.add('on'));
    es.addEventListener('error', () => $('live').classList.remove('on'));
    es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
    es.addEventListener('event', (e) => onEvent(JSON.parse(e.data)));
    es.addEventListener('forget', (e) => onForget(JSON.parse(e.data)));
  }

  // ================== vues ==================
  function chooseInitialView() {
    const h = location.hash;
    const m = h.match(/^#s=(.+)$/);
    if (m && sessions.has(decodeURIComponent(m[1]))) return setView('dungeon', decodeURIComponent(m[1]));
    if (h === '#realm') return setView('realm');
    const now = Date.now();
    const busy = [...sessions.values()].filter((r) => ['working', 'permission', 'input'].includes(M.status(r.S, now)));
    if (busy.length === 1) return setView('dungeon', busy[0].id);
    if (sessions.size === 1) return setView('dungeon', [...sessions.keys()][0]);
    setView('realm');
  }

  function setView(mode, id, keepAnim) {
    if (mode === 'dungeon' && !sessions.has(id)) mode = 'realm';
    const changed = mode !== view.mode || id !== view.id;
    if (changed) replay = null;
    view.mode = mode; view.id = mode === 'dungeon' ? id : null;
    try { history.replaceState(null, '', mode === 'dungeon' ? `#s=${encodeURIComponent(id)}` : '#realm'); } catch { /* sans importance */ }
    if (mode === 'dungeon') {
      if (changed || !keepAnim || !anim) { anim = createAnim(shownS()); FX.clear(); cam.snap = true; cam.mode = 'auto'; }
      else anim = createAnim(shownS(), anim);
    } else anim = null;
    log.reset();
    ui.dirty = true;
  }

  // ================== carte : disposition des salles ==================
  const TILE_W = 44, TILE_H = 44, PAD = 12, HEAD = 28, GAPX = 64, GAPY = 24, MAXCOLS = 7, MAXTILES = 49;
  const segName = (key) => (key === '↗' ? '↗ hors du projet' : key.slice(key.lastIndexOf('/') + 1));
  const doorY = (r) => r.y + HEAD / 2 + 1;

  function computeLayout(S) {
    const rooms = new Map(), alias = new Map(), tileOf = new Map();
    function make(key, label) {
      let k = key, lab = label, d = S.dirs.get(key);
      const chain = [key];
      // dossiers intermédiaires vides fusionnés : « api/src/Entity » au lieu de trois salles
      while (k !== '.' && k !== '↗' && d.files.length === 0 && d.children.length === 1) {
        const ck = d.children[0];
        lab = `${lab}/${segName(ck)}`; k = ck; d = S.dirs.get(ck); chain.push(ck);
      }
      const files = d.files.map((fk) => S.files.get(fk)).filter(Boolean);
      const n = Math.min(files.length, MAXTILES);
      const cols = n ? Math.max(2, Math.min(MAXCOLS, Math.ceil(Math.sqrt(n * 1.6)))) : 0;
      const rows = n ? Math.ceil(n / cols) : 0;
      const w = Math.max(150, PAD * 2 + cols * TILE_W, Math.min(330, lab.length * 8.4 + 34));
      const h = n ? HEAD + PAD / 2 + rows * TILE_H + PAD / 2 : HEAD + 34;
      const room = { key: k, label: lab, files, n, cols, overflow: files.length - n, w, h, x: 0, y: 0, parent: null, children: [], scan: -1e9 };
      for (const c of chain) alias.set(c, room);
      rooms.set(k, room);
      room.children = d.children.map((ck) => { const r = make(ck, segName(ck)); r.parent = room; return r; });
      return room;
    }
    const root = make('.', S.project);
    function place(r, x, y) {
      r.x = x; r.y = y;
      let cy = y;
      for (const c of r.children) cy += place(c, x + r.w + GAPX, cy) + GAPY;
      return Math.max(r.h, cy - GAPY - y);
    }
    place(root, 0, 0);
    for (const r of rooms.values()) {
      r.files.forEach((f, i) => {
        if (i >= r.n) { tileOf.set(f.key, { room: r, x: r.x + r.w - 24, y: r.y + r.h - 16, hidden: true }); return; }
        tileOf.set(f.key, { room: r, x: r.x + PAD + (i % r.cols) * TILE_W + TILE_W / 2, y: r.y + HEAD + PAD / 2 + Math.floor(i / r.cols) * TILE_H + TILE_H / 2 - 6, file: f });
      });
    }
    // antre des objectifs, à gauche de l'entrée
    let antre = null;
    if (S.objectives.length) {
      const n = S.objectives.length, cols = Math.min(4, n), rows = Math.ceil(n / cols);
      const w = Math.max(200, PAD * 2 + cols * 82), h = HEAD + PAD + rows * 62;
      antre = { x: root.x - GAPX - w, y: root.y, w, h, slot: (i) => ({ x: root.x - GAPX - w + PAD + ((i % cols) + 0.5) * ((w - PAD * 2) / cols), y: root.y + HEAD + 30 + Math.floor(i / cols) * 62 }) };
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of [...rooms.values(), antre].filter(Boolean)) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    return { rooms, alias, tileOf, root, antre, bounds: { x0, y0, x1, y1 }, list: [...rooms.values()] };
  }

  function layoutKey(S) { return `${S.mapRev}|${S.objectives.length}`; }

  function pointFor(L, m) {
    if (m.file) {
      const t = L.tileOf.get(m.file);
      if (t) return { room: t.room, x: t.x, y: t.y + 16 };
    }
    const d = m.dir || (m.file ? (m.file.includes('/') ? m.file.slice(0, m.file.lastIndexOf('/')) : '.') : null);
    if (d) {
      const r = L.alias.get(d);
      if (r) return { room: r, x: r.x + r.w / 2, y: r.y + Math.min(r.h - 10, HEAD + 30) };
    }
    return null;
  }

  // Trajet dans les couloirs : on remonte jusqu'au dossier commun puis on redescend.
  function route(L, from, to) {
    // salles toujours prises dans la disposition courante (elle change quand une salle apparaît)
    const cur = (r) => (r ? L.rooms.get(r.key) || L.root : L.root);
    const a = cur(from.room), b = to.room ? cur(to.room) : null;
    if (!b) return [{ x: from.x, y: from.y }, { x: to.x, y: to.y }];
    const pts = [{ x: from.x, y: from.y }];
    if (a === b) { pts.push({ x: to.x, y: from.y }, { x: to.x, y: to.y }); return pts; }
    const anc = new Set();
    for (let r = b; r; r = r.parent) anc.add(r);
    pts.push({ x: from.x, y: doorY(a) });
    let r = a;
    while (!anc.has(r) && r.parent) {
      const p = r.parent, tx = p.x + p.w + GAPX / 2;
      pts.push({ x: r.x, y: doorY(r) }, { x: tx, y: doorY(r) }, { x: tx, y: doorY(p) }, { x: p.x + p.w, y: doorY(p) });
      r = p;
    }
    const down = [];
    for (let q = b; q && q !== r; q = q.parent) down.unshift(q);
    for (const c of down) {
      if (!c.parent) continue;
      const p = c.parent, tx = p.x + p.w + GAPX / 2;
      pts.push({ x: p.x + p.w, y: doorY(p) }, { x: tx, y: doorY(p) }, { x: tx, y: doorY(c) }, { x: c.x, y: doorY(c) });
    }
    pts.push({ x: to.x, y: doorY(b) }, { x: to.x, y: to.y });
    return pts;
  }

  // ================== animation : héros, compagnons, monstres ==================
  function createAnim(S, prev) {
    const L = computeLayout(S);
    const a = { S, L, lkey: layoutKey(S), actors: new Map(), glow: new Map(), objOverride: new Map(), monsters: new Map() };
    const heroPt = (S.heroAt && pointFor(L, S.files.has(S.heroAt) ? { file: S.heroAt } : { dir: S.heroAt })) || { room: L.root, x: L.root.x + L.root.w / 2, y: L.root.y + Math.min(L.root.h - 10, HEAD + 30) };
    a.actors.set('hero', makeActor('hero', 'hero', heroPt, ''));
    for (const c of M.activeCompanions(S)) {
      const p = (c.at && pointFor(L, S.files.has(c.at) ? { file: c.at } : { dir: c.at })) || { room: heroPt.room, x: heroPt.x + 30, y: heroPt.y };
      a.actors.set(c.agentId, makeActor('ally', c.agentId, p, short(M.launchLabel(c.launch), 22)));
    }
    if (prev) {
      for (const [k, act] of prev.actors) if (a.actors.has(k)) Object.assign(a.actors.get(k), { x: act.x, y: act.y, room: act.room ? L.rooms.get(act.room.key) || L.root : L.root });
      a.glow = prev.glow;
    }
    return a;
  }

  function makeActor(kind, key, p, label) {
    return { kind, key, x: p.x, y: p.y, room: p.room, label, queue: [], step: null, bubble: null, hurt: -1e9, fade: 1, leaving: false };
  }

  function enqueue(a, moves, prev) {
    for (const m of moves) {
      if (m.act === 'say') continue;
      if (m.obj != null && !a.objOverride.has(m.obj)) a.objOverride.set(m.obj, prev.get(m.obj) || 'pending');
      let actor = a.actors.get(m.actor);
      if (!actor) {
        if (m.act === 'return') continue;
        const hero = a.actors.get('hero');
        const c = a.S.companions.get(m.actor);
        actor = makeActor('ally', m.actor, { x: hero.x, y: hero.y, room: hero.room }, short(c ? M.launchLabel(c.launch) : 'Compagnon', 22));
        actor.fade = 0;
        a.actors.set(m.actor, actor);
        FX.sparkle(hero.x, hero.y - 10, '#5cc8c2', 14);
      }
      actor.queue.push(m);
    }
  }

  function relayout(a) {
    const k = layoutKey(a.S);
    if (k === a.lkey) return;
    const L = computeLayout(a.S);
    // les acteurs gardent leur salle : on les recale sur sa nouvelle position
    for (const act of a.actors.values()) {
      if (act.room && !act.step) {
        const nr = L.rooms.get(act.room.key);
        if (nr) { act.x += nr.x - act.room.x; act.y += nr.y - act.room.y; act.room = nr; } else act.room = L.root;
      } else if (act.room) act.room = L.rooms.get(act.room.key) || L.root;
    }
    a.L = L; a.lkey = k;
  }

  function startStep(a, actor, m, now) {
    const sp = SPEEDS[speed];
    let target = null;
    if (m.act === 'return') {
      const hero = a.actors.get('hero');
      target = { room: hero.room, x: hero.x + 22, y: hero.y };
      actor.leaving = true;
    } else if (m.file || m.dir) target = pointFor(a.L, m);
    let pts = [{ x: actor.x, y: actor.y }], len = 0;
    if (target) {
      pts = route(a.L, actor, target);
      for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    }
    const travel = len < 2 ? 0 : Math.min(len / sp.pxPerMs, sp.minDur * 1.8);
    actor.step = { m, t0: now, pts, len, travel, total: Math.max(sp.minDur, travel + 180), arrived: false, target };
  }

  function posAlong(pts, d) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const seg = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (d <= seg || i === pts.length - 1) { const k = seg ? Math.min(1, d / seg) : 1; return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }; }
      d -= seg;
    }
    return pts[pts.length - 1];
  }

  function stepActors(a, now) {
    for (const actor of [...a.actors.values()]) {
      if (!actor.step && actor.queue.length) {
        if (actor.queue.length > SKIP_AT) {
          const dropped = actor.queue.splice(0, actor.queue.length - 1);
          for (const d of dropped) if (d.obj != null) a.objOverride.delete(d.obj);
        }
        startStep(a, actor, actor.queue.shift(), now);
      }
      const st = actor.step;
      if (st) {
        const k = st.travel ? Math.min(1, (now - st.t0) / st.travel) : 1;
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const p = posAlong(st.pts, e * st.len);
        actor.x = p.x; actor.y = p.y;
        if (k >= 1 && !st.arrived) { st.arrived = true; if (st.target && st.target.room) actor.room = a.L.rooms.get(st.target.room.key) || a.L.root; arrive(a, actor, st.m, now); }
        if (now - st.t0 >= st.total) actor.step = null;
      }
      if (actor.kind === 'ally') {
        actor.fade = actor.leaving && !actor.step && !actor.queue.length ? actor.fade - 0.04 : Math.min(1, actor.fade + 0.05);
        if (actor.fade <= 0) a.actors.delete(actor.key);
      }
    }
  }

  function arrive(a, actor, m, now) {
    const x = actor.x, y = actor.y;
    const bubble = (text) => { actor.bubble = { text, until: now + 2400 }; };
    switch (m.act) {
      case 'read': if (m.file) a.glow.set(m.file, now); FX.sparkle(x, y - 20, '#9db4ff', 8); break;
      case 'scan': { const r = a.L.alias.get(m.dir); if (r) r.scan = now; break; }
      case 'forge': if (m.file) a.glow.set(m.file, now); FX.sparkle(x, y - 20, '#ffcf6b', 20); FX.float(x, y - 40, '+5 XP', '#e7b84b'); break;
      case 'create': if (m.file) a.glow.set(m.file, now); FX.sparkle(x, y - 20, '#6fd896', 24); FX.float(x, y - 40, '+10 XP', '#6fd896'); break;
      case 'spell': bubble('🔮 ' + (m.text || '')); FX.ring(x, y - 10, '#8f7cff', 46); if (m.file) a.glow.set(m.file, now); break;
      case 'test': bubble('🧪 ' + (m.text || '')); FX.ring(x, y - 10, '#5cc8c2', 46); break;
      case 'cast': bubble(m.text || '✨'); break;
      case 'fail': actor.hurt = now; FX.float(x, y - 38, '−7 PV', '#e0524a'); FX.sparkle(x, y - 14, '#e0524a', 14); break;
      case 'summon': bubble('🧝 ' + (m.text || 'À toi, compagnon !')); FX.sparkle(x, y - 14, '#5cc8c2', 16); break;
      case 'rest': banner('QUÊTE ACCOMPLIE'); FX.sparkle(x, y - 14, '#e7b84b', 30); break;
      case 'engage': a.objOverride.delete(m.obj); bubble('⚔ En garde !'); break;
      case 'victory': {
        const mon = a.monsters.get(m.obj);
        a.objOverride.delete(m.obj);
        const mx = mon ? mon.x : x + 26, my = mon ? mon.y : y;
        FX.sparkle(mx, my - 10, '#e0524a', 18); FX.sparkle(mx, my - 10, '#e7b84b', 26);
        FX.float(mx, my - 40, '+20 XP', '#e7b84b');
        FX.chest(mx, my);
        banner('OBJECTIF VAINCU', m.text);
        break;
      }
      case 'return': FX.sparkle(x, y - 10, '#5cc8c2', 12); break;
    }
  }

  // ================== effets ==================
  const FX = {
    parts: [], texts: [], rings: [], chests: [],
    sparkle(x, y, color, n) {
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + (i % 3), s = 0.6 + ((i * 7) % 10) / 4.5;
        this.parts.push({ x, y, vx: Math.cos(ang) * s, vy: Math.sin(ang) * s - 0.8, life: 1, color, size: 2 + (i % 3) });
      }
    },
    float(x, y, text, color) { this.texts.push({ x, y, text, color, life: 1 }); },
    ring(x, y, color, max = 170) { this.rings.push({ x, y, color, r: 4, max, life: 1 }); },
    chest(x, y) { this.chests.push({ x, y, life: 1 }); },
    step(dt) {
      for (const p of this.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 0.06 * dt; p.life -= 0.022 * dt; }
      for (const t of this.texts) { t.y -= 0.5 * dt; t.life -= 0.012 * dt; }
      for (const r of this.rings) { r.r += (r.max - r.r) * 0.06 * dt; r.life -= 0.018 * dt; }
      for (const c of this.chests) { c.y -= 0.25 * dt; c.life -= 0.008 * dt; }
      this.parts = this.parts.filter((p) => p.life > 0);
      this.texts = this.texts.filter((t) => t.life > 0);
      this.rings = this.rings.filter((r) => r.life > 0);
      this.chests = this.chests.filter((c) => c.life > 0);
    },
    clear() { this.parts = []; this.texts = []; this.rings = []; this.chests = []; },
  };

  let bannerTimer = null;
  function banner(text, sub) {
    const b = $('banner');
    b.textContent = text;
    if (sub) b.appendChild(el('small', null, short(sub, 60)));
    b.classList.add('show');
    clearTimeout(bannerTimer); bannerTimer = setTimeout(() => b.classList.remove('show'), 2600);
  }

  // ================== caméra et souris ==================
  const cv = $('map'), ctx = cv.getContext('2d');
  const cam = { x: 0, y: 0, s: 1, snap: true, mode: 'auto' };
  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  window.addEventListener('resize', resize);

  function updateCamera(a, dt) {
    if (cam.mode === 'manual') return;
    const b = a.L.bounds, m = 40, top = 80, left = W > 900 ? 250 : 0;
    const fit = Math.min(1.3, (W - left - m * 2) / Math.max(1, b.x1 - b.x0), (H - top - m * 2) / Math.max(1, b.y1 - b.y0));
    const hero = a.actors.get('hero');
    let tx, ty, s;
    if (cam.mode === 'overview' || (cam.mode === 'auto' && fit >= 0.55)) {
      s = cam.mode === 'overview' ? Math.min(fit, 1.3) : fit;
      tx = (b.x0 + b.x1) / 2 - left / 2 / s; ty = (b.y0 + b.y1) / 2 - top / 2 / s;
    } else {
      s = cam.mode === 'follow' ? 1 : 0.85;
      tx = hero.x - left / 2 / s; ty = hero.y - top / 2 / s;
    }
    if (cam.snap) { cam.x = tx; cam.y = ty; cam.s = s; cam.snap = false; return; }
    const k = 1 - Math.pow(0.93, dt);
    cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; cam.s += (s - cam.s) * k;
  }
  const toWorld = (px, py) => ({ x: cam.x + (px - W / 2) / cam.s, y: cam.y + (py - H / 2) / cam.s });

  let drag = null;
  cv.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false }; });
  window.addEventListener('mouseup', () => { drag = null; cv.classList.remove('drag'); });
  window.addEventListener('mousemove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; cam.mode = 'manual'; cv.classList.add('drag'); }
      if (drag.moved) { cam.x = drag.cx - dx / cam.s; cam.y = drag.cy - dy / cam.s; hideTip(); }
      return;
    }
    if (e.target === cv) hover(e); else hideTip();
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const before = toWorld(e.clientX - r.left, e.clientY - r.top);
    cam.mode = 'manual';
    cam.s = Math.max(0.15, Math.min(2.5, cam.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const after = toWorld(e.clientX - r.left, e.clientY - r.top);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
  }, { passive: false });
  cv.addEventListener('dblclick', () => { cam.mode = 'auto'; });
  cv.addEventListener('mouseleave', hideTip);
  $('follow').addEventListener('click', () => { cam.mode = cam.mode === 'follow' ? 'auto' : 'follow'; });
  $('overview').addEventListener('click', () => { cam.mode = cam.mode === 'overview' ? 'auto' : 'overview'; });

  const tip = $('tip');
  function hideTip() { tip.style.display = 'none'; }
  function showTip(e, html) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const r = $('stage').getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    if (x + tip.offsetWidth > r.width - 8) x = e.clientX - r.left - tip.offsetWidth - 10;
    if (y + tip.offsetHeight > r.height - 8) y = e.clientY - r.top - tip.offsetHeight - 10;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STATE_FR = { seen: 'lu', edited: 'modifié', created: 'créé' };
  function hover(e) {
    if (!anim || view.mode !== 'dungeon') return hideTip();
    const r = cv.getBoundingClientRect();
    const p = toWorld(e.clientX - r.left, e.clientY - r.top);
    const S = anim.S;
    for (const [id, mon] of anim.monsters) {
      if (Math.abs(p.x - mon.x) < 14 && p.y > mon.y - 26 && p.y < mon.y + 4) {
        const o = S.objectives.find((x) => x.id === id);
        if (o) return showTip(e, `<b>${o.status === 'completed' ? '🏆 Vaincu' : o.status === 'in_progress' ? '⚔ En combat' : '💤 À affronter'}</b><br>${esc(o.text)}`);
      }
    }
    for (const act of anim.actors.values()) {
      if (act.kind === 'ally' && Math.abs(p.x - act.x) < 12 && p.y > act.y - 26 && p.y < act.y + 2) {
        const c = S.companions.get(act.key);
        return showTip(e, `<b>🧝 ${esc(c ? M.launchLabel(c.launch) : 'Compagnon')}</b><br><span class="dim">${c ? c.actions : 0} actions</span>`);
      }
    }
    for (const t of anim.L.tileOf.values()) {
      if (t.file && Math.abs(p.x - t.x) < 18 && Math.abs(p.y - t.y) < 14) {
        const f = t.file;
        return showTip(e, `<b>${esc(M.displayKey(f.key))}</b><br><span class="dim">${STATE_FR[f.state]} · ${f.reads} lecture${f.reads > 1 ? 's' : ''}${f.edits ? ` · ${f.edits} forge${f.edits > 1 ? 's' : ''}` : ''}</span>`);
      }
    }
    for (const room of anim.L.list) {
      if (p.x >= room.x && p.x <= room.x + room.w && p.y >= room.y && p.y <= room.y + HEAD) {
        return showTip(e, `<b>📁 ${esc(room.key === '.' ? S.cwd : M.displayKey(room.key))}</b><br><span class="dim">${room.files.length} fichier${room.files.length > 1 ? 's' : ''} visité${room.files.length > 1 ? 's' : ''}</span>`);
      }
    }
    hideTip();
  }

  // ================== dessin ==================
  const COL = {
    floor: '#121019', wall: '#2a2638', corridor: '#191621', corridorEdge: '#2f2a3e',
    seen: '#25213a', seenEdge: '#5b5486', edited: '#3a2c14', editedEdge: '#e7b84b', created: '#163021', createdEdge: '#6fd896',
    label: '#cfc6b3', zoneLabel: '#8f86a3', hero: '#f0a24a', cape: '#b5532a', ally: '#5cc8c2',
  };
  const HERO = ['..CCCC..', '.CCCCCC.', '.CFFFFC.', '.CFEFEC.', '..FFFF..', '.KKBBKK.', 'KKBBBBKK', '.KBBBBK.', '..BB.BB.', '..DD.DD.'];
  const HERO_PAL = { C: COL.hero, F: '#f3d2b0', E: '#1a1020', K: COL.cape, B: '#5a3a7a', D: '#2a1d14' };
  const ALLY_PAL = { C: COL.ally, F: '#f3d2b0', E: '#1a1020', K: '#2d7f7a', B: '#1f4d5a', D: '#16242a' };
  const MONSTER = ['..GGGG..', '.GGGGGG.', 'GGEGGEGG', 'GGPGGPGG', 'GGGGGGGG', 'GGMMMMGG', '.GGGGGG.', '.G.GG.G.'];
  const MONSTER_COLORS = ['#7bd36f', '#d86a6a', '#b07be0', '#e0a94f', '#5fb8d6', '#d6779f'];
  const CHEST = ['.DDDDDD.', 'DBBBBBBD', 'DYYLLYYD', 'DBBLLBBD', 'DBBBBBBD', 'DDDDDDDD'];
  const CHEST_PAL = { D: '#4a2a12', B: '#8a5a2a', Y: '#e7b84b', L: '#f6e08a' };

  function sprite(map, x, y, px, pal, flash) {
    const h = map.length, w = map[0].length;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const c = map[j][i]; if (c === '.') continue;
      ctx.fillStyle = flash || pal[c];
      ctx.fillRect(x + (i - w / 2) * px, y + (j - h) * px, px, px);
    }
  }

  function drawCorridor(pts) {
    ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
    for (const [lw, c] of [[16, COL.corridorEdge], [10, COL.corridor]]) {
      ctx.strokeStyle = c; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }

  function drawRoomShell(x, y, w, h, wall, label, labelColor, now, scan) {
    ctx.fillStyle = COL.floor; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.025)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let gx = x; gx <= x + w; gx += 16) { ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); }
    for (let gy = y; gy <= y + h; gy += 16) { ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); }
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x, y, w, HEAD);
    ctx.strokeStyle = wall; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = wall;
    for (let gx = x + 6; gx < x + w - 6; gx += 22) ctx.fillRect(gx, y - 5, 10, 5);
    if (now - scan < 1400) {
      const k = (now - scan) / 1400;
      ctx.strokeStyle = `rgba(92,200,194,${0.8 * (1 - k)})`; ctx.lineWidth = 3;
      ctx.strokeRect(x - 6 * k, y - 6 * k, w + 12 * k, h + 12 * k);
    }
    if (cam.s > 0.3) {
      ctx.fillStyle = labelColor; ctx.font = '18px VT323, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(short(label, Math.floor((w - 16) / 8.4)), x + 8, y + HEAD / 2 + 1);
    }
  }

  function drawRoom(a, r, now) {
    const isRoot = r.key === '.';
    drawRoomShell(r.x, r.y, r.w, r.h, isRoot ? '#3a3450' : r.key.startsWith('↗') ? '#2a3238' : COL.wall, isRoot ? `⛩ ${r.label}` : r.label, isRoot ? COL.label : r.key.startsWith('↗') ? '#7fa3a8' : COL.zoneLabel, now, r.scan);
    for (let i = 0; i < r.n; i++) {
      const f = r.files[i], t = a.L.tileOf.get(f.key);
      const fill = COL[f.state], edge = COL[f.state + 'Edge'];
      const g = a.glow.get(f.key);
      const glow = g ? Math.max(0, 1 - (now - g) / 1800) : 0;
      if (glow > 0) { ctx.shadowColor = edge; ctx.shadowBlur = 22 * glow; }
      ctx.fillStyle = fill; ctx.fillRect(t.x - 15, t.y - 11, 30, 22);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = edge; ctx.lineWidth = 2; ctx.strokeRect(t.x - 14, t.y - 10, 28, 20);
      if (f.state === 'seen') { ctx.fillStyle = '#8f86c8'; ctx.fillRect(t.x - 6, t.y - 4, 12, 2); ctx.fillRect(t.x - 6, t.y, 9, 2); }
      if (f.state === 'edited') { ctx.fillStyle = '#e7b84b'; ctx.fillRect(t.x - 5, t.y - 3, 10, 3); ctx.fillRect(t.x - 2, t.y, 4, 5); }
      if (f.state === 'created') { ctx.fillStyle = '#6fd896'; ctx.fillRect(t.x - 1, t.y - 6, 2, 12); ctx.fillRect(t.x - 6, t.y - 1, 12, 2); }
      if (cam.s > 0.8) {
        ctx.fillStyle = glow > 0 ? '#fff3d6' : COL.label; ctx.font = '13px VT323, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(short(f.name, 9), t.x, t.y + 12);
        ctx.textAlign = 'left';
      }
    }
    if (r.overflow > 0 && cam.s > 0.4) {
      ctx.fillStyle = COL.zoneLabel; ctx.font = '15px VT323, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(`+${r.overflow}`, r.x + r.w - 6, r.y + r.h - 3); ctx.textAlign = 'left';
    }
  }

  function objectiveView(a) {
    return a.S.objectives.map((o) => ({ o, status: a.objOverride.has(o.id) ? a.objOverride.get(o.id) : o.status }));
  }

  function drawAntre(a, now) {
    const an = a.L.antre;
    if (!an) return;
    drawCorridor([{ x: an.x + an.w, y: doorY(an) }, { x: a.L.root.x, y: doorY(a.L.root) }]);
    drawRoomShell(an.x, an.y, an.w, an.h, '#4a2630', '👹 Antre des objectifs', '#d9a0a0', now, -1e9);
  }

  function drawMonsters(a, now, dt) {
    const hero = a.actors.get('hero');
    const ov = objectiveView(a);
    let engaged = 0;
    ov.forEach(({ o, status }, idx) => {
      const slot = a.L.antre ? a.L.antre.slot(idx) : { x: hero.x, y: hero.y };
      let tx = slot.x, ty = slot.y;
      if (status === 'in_progress') { tx = hero.x + 28 + engaged * 22; ty = hero.y + 2; engaged++; }
      let m = a.monsters.get(o.id);
      if (!m) { m = { x: tx, y: ty }; a.monsters.set(o.id, m); }
      const k = 1 - Math.pow(0.9, dt);
      m.x += (tx - m.x) * k; m.y += (ty - m.y) * k;
      const color = MONSTER_COLORS[hash(o.text) % MONSTER_COLORS.length];
      if (status === 'completed') {
        sprite(CHEST, m.x, m.y, 3, CHEST_PAL);
        ctx.fillStyle = `rgba(246,224,138,${0.5 + 0.5 * Math.sin(now / 300 + o.slot)})`;
        ctx.fillRect(m.x - 1, m.y - 22, 2, 2);
      } else {
        const fighting = status === 'in_progress';
        const bob = fighting ? Math.abs(Math.sin(now / 140)) * -4 : Math.sin(now / 700 + o.slot) * 1;
        sprite(MONSTER, m.x, m.y + bob, 3, { G: fighting ? color : shade(color), E: '#fff', P: '#1a1020', M: '#3a1010' });
        if (!fighting) {
          ctx.fillStyle = 'rgba(200,200,255,0.7)'; ctx.font = '14px VT323, monospace'; ctx.textAlign = 'left';
          ctx.fillText('z', m.x + 12, m.y - 26 + Math.sin(now / 500 + o.slot) * 3);
        } else {
          const hp = Math.max(0.15, 1 - o.actions * 0.04);
          ctx.fillStyle = '#000'; ctx.fillRect(m.x - 14, m.y - 34, 28, 5);
          ctx.fillStyle = '#e0524a'; ctx.fillRect(m.x - 13, m.y - 33, 26 * hp, 3);
          if (Math.floor(now / 300) % 3 === 0) { ctx.fillStyle = '#fff3d6'; ctx.fillRect(m.x - 18, m.y - 14, 3, 3); }
        }
      }
      if (cam.s > 0.75 && status !== 'in_progress') {
        ctx.fillStyle = status === 'completed' ? '#8fbf98' : '#c9b2b2'; ctx.font = '13px VT323, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(short(o.text, 11), m.x, m.y + 3); ctx.textAlign = 'left';
      }
    });
  }
  function shade(hex) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.round(v * 0.55);
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  function drawActors(a, now) {
    const S = a.S;
    for (const act of a.actors.values()) {
      if (act.kind !== 'ally') continue;
      ctx.globalAlpha = Math.max(0, act.fade);
      const bob = act.step && !act.step.arrived ? Math.sin(now / 70) * 1.2 : 0;
      sprite(HERO, act.x, act.y + bob, 2, ALLY_PAL, now - act.hurt < 300 ? '#ff6b62' : null);
      if (cam.s > 0.55) {
        ctx.fillStyle = COL.ally; ctx.font = '13px VT323, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(act.label, act.x, act.y - 22); ctx.textAlign = 'left';
      }
      drawBubble(act, now, -38);
      ctx.globalAlpha = 1;
    }
    const h = a.actors.get('hero');
    const moving = h.step && !h.step.arrived;
    const bob = moving ? Math.sin(now / 70) * 1.5 : Math.sin(now / 400);
    ctx.fillStyle = 'rgba(240,162,74,0.15)';
    ctx.beginPath(); ctx.arc(h.x, h.y - 14, 26 + Math.sin(now / 150) * 2, 0, 7); ctx.fill();
    sprite(HERO, h.x, h.y + bob, 3, HERO_PAL, now - h.hurt < 300 ? '#ff6b62' : null);
    const st = M.status(S, Date.now());
    if (S.waiting) {
      ctx.fillStyle = S.waiting.kind === 'permission' ? '#ff6b62' : '#ffd34d';
      ctx.font = '22px "Press Start 2P", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(S.waiting.kind === 'permission' ? '!' : '?', h.x, h.y - 40 + Math.sin(now / 120) * 4); ctx.textAlign = 'left';
    } else if (st === 'done' || st === 'sleep') {
      ctx.fillStyle = 'rgba(200,200,255,0.75)'; ctx.font = '18px VT323, monospace'; ctx.textBaseline = 'bottom';
      ctx.fillText('z', h.x + 12, h.y - 30 + Math.sin(now / 500) * 3);
      ctx.fillText('z', h.x + 20, h.y - 40 + Math.sin(now / 500 + 1) * 3);
    }
    drawBubble(h, now, -52);
  }

  function drawBubble(act, now, dy) {
    const b = act.bubble;
    if (!b || now > b.until) return;
    ctx.font = '16px VT323, monospace';
    const text = short(b.text, 48);
    const tw = ctx.measureText(text).width, bx = act.x - tw / 2 - 8, by = act.y + dy - 22;
    ctx.globalAlpha = Math.min(ctx.globalAlpha, Math.min(1, (b.until - now) / 400));
    ctx.fillStyle = 'rgba(232,225,207,0.95)'; ctx.fillRect(bx, by, tw + 16, 22);
    ctx.fillRect(act.x - 4, by + 22, 8, 5);
    ctx.fillStyle = '#16141d'; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillText(text, bx + 8, by + 3);
    ctx.globalAlpha = 1;
  }

  function drawFx() {
    for (const r of FX.rings) {
      ctx.strokeStyle = r.color; ctx.globalAlpha = Math.max(0, r.life); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 7); ctx.stroke();
    }
    for (const p of FX.parts) { ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.size, p.size); }
    for (const c of FX.chests) { ctx.globalAlpha = Math.max(0, Math.min(1, c.life * 2)); sprite(CHEST, c.x, c.y - 20, 4, CHEST_PAL); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (const t of FX.texts) {
      ctx.globalAlpha = Math.max(0, t.life);
      ctx.font = '12px "Press Start 2P", monospace';
      ctx.fillStyle = '#000'; ctx.fillText(t.text, t.x + 2, t.y + 2);
      ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
    }
    ctx.textAlign = 'left'; ctx.globalAlpha = 1;
  }

  function drawDungeon(now, dt) {
    const a = anim;
    relayout(a);
    stepActors(a, now);
    updateCamera(a, dt);
    FX.step(dt);
    ctx.setTransform(dpr * cam.s, 0, 0, dpr * cam.s, dpr * (W / 2 - cam.x * cam.s), dpr * (H / 2 - cam.y * cam.s));
    // couloirs (sous les salles)
    for (const r of a.L.list) {
      if (!r.parent) continue;
      const p = r.parent, tx = p.x + p.w + GAPX / 2;
      drawCorridor([{ x: p.x + p.w - 2, y: doorY(p) }, { x: tx, y: doorY(p) }, { x: tx, y: doorY(r) }, { x: r.x + 2, y: doorY(r) }]);
    }
    drawAntre(a, now);
    for (const r of a.L.list) drawRoom(a, r, now);
    drawMonsters(a, now, dt);
    drawActors(a, now);
    drawFx();
    // brouillard : tout est un peu sombre sauf autour du héros
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const h = a.actors.get('hero');
    const hx = W / 2 + (h.x - cam.x) * cam.s, hy = H / 2 + (h.y - cam.y) * cam.s;
    const g = ctx.createRadialGradient(hx, hy, 60 * cam.s, hx, hy, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // ================== royaume ==================
  const STATUS_COLOR = { working: '#f0a24a', permission: '#e0524a', input: '#e7b84b', done: '#6fd896', sleep: '#5d566d', ended: '#3a3450' };
  function drawCastle(c, status, now) {
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const stone = status === 'sleep' || status === 'ended' ? '#2c2838' : '#3d3752', dark = '#26222f';
    g.fillStyle = '#16131e'; g.fillRect(0, 26, 36, 4);
    g.fillStyle = stone; g.fillRect(6, 12, 24, 15); g.fillRect(2, 8, 8, 19); g.fillRect(26, 8, 8, 19);
    g.fillStyle = dark;
    for (const x of [2, 6, 26, 30]) g.fillRect(x, 6, 2, 2);
    for (const x of [8, 12, 16, 20, 24]) g.fillRect(x, 10, 2, 2);
    g.fillRect(15, 19, 6, 8);
    const lit = status === 'working' || status === 'permission' || status === 'input';
    g.fillStyle = lit ? (Math.floor(now / 400) % 2 ? '#f0a24a' : '#e7b84b') : '#1f1c29';
    g.fillRect(5, 13, 2, 3); g.fillRect(29, 13, 2, 3); g.fillRect(11, 15, 2, 2); g.fillRect(23, 15, 2, 2);
    g.fillStyle = '#6b5a3a'; g.fillRect(17, 0, 1, 12);
    const col = STATUS_COLOR[status] || '#5d566d';
    const wave = Math.floor(now / 250) % 2;
    if (!(status === 'permission' && Math.floor(now / 400) % 2)) {
      g.fillStyle = col; g.fillRect(18, 1, 7, 2); g.fillRect(18, 3, 6 + wave, 2); g.fillRect(18, 5, 5, 1);
    }
    if (status === 'working') { g.fillStyle = Math.floor(now / 150) % 2 ? '#ffd27a' : '#f0a24a'; g.fillRect(13, 20, 1, 2); g.fillRect(22, 20, 1, 2); }
  }

  const realm = { sig: '' };
  function projectsList(now) {
    const byCwd = new Map();
    for (const rec of sessions.values()) {
      const k = rec.S.cwd || rec.cwd || '?';
      if (!byCwd.has(k)) byCwd.set(k, []);
      byCwd.get(k).push(rec);
    }
    const rank = { permission: 0, input: 1, working: 2, done: 3, sleep: 4, ended: 5 };
    return [...byCwd.entries()].map(([cwd, recs]) => {
      recs.sort((a, b) => (a.S.firstAt || 0) - (b.S.firstAt || 0));
      const sts = recs.map((r) => M.status(r.S, now));
      const best = sts.reduce((a, b) => (rank[a] <= rank[b] ? a : b));
      return { cwd, recs, status: best, last: Math.max(...recs.map((r) => r.S.lastAt || 0)) };
    }).sort((a, b) => b.last - a.last);
  }

  function renderRealm(now) {
    const box = $('realm');
    const projects = projectsList(now);
    const sig = projects.map((p) => p.cwd + p.status + p.recs.map((r) => r.S.rev + M.status(r.S, now)).join()).join('|') + Math.floor(now / 10000);
    if (sig === realm.sig) return;
    realm.sig = sig;
    box.innerHTML = '';
    box.appendChild(el('h2', null, '🏰 LE ROYAUME'));
    box.appendChild(el('p', null, `${pl(projects.length, 'projet', 'projets')}, ${pl(sessions.size, 'héros', 'héros')}. Clique sur un héros pour entrer dans son donjon.`));
    const grid = el('div', 'castles');
    for (const p of projects) {
      const card = el('section', `castle st-${p.status}`);
      const head = el('header');
      const c = el('canvas'); c.width = 36; c.height = 30; c.dataset.status = p.status;
      const info = el('div');
      info.append(el('h3', null, basename(p.cwd) || '?'), el('div', 'path', p.cwd.replace(/^\/home\/[^/]+/, '~')));
      head.append(c, info);
      card.appendChild(head);
      p.recs.forEach((rec, i) => {
        const S = rec.S, st = M.status(S, now);
        const row = el('button', `hero-row st-${st}`);
        row.dataset.id = rec.id;
        const top = el('div', 'top');
        top.append(el('span', `dot st-${st}`), el('span', 'state', `${STATUS[st].icon} ${p.recs.length > 1 ? `Héros ${i + 1} · ` : ''}${STATUS[st].label}`));
        const allies = M.activeCompanions(S).length;
        if (allies) top.append(el('span', null, `🧝 ${allies}`));
        top.append(el('span', 'ago', S.lastAt ? ago(S.lastAt, now) : ''));
        const forget = el('span', 'forget', '✕');
        forget.title = 'Oublier ce héros (session fermée sans que le donjon le sache)';
        top.append(forget);
        row.appendChild(top);
        row.appendChild(el('div', 'q', S.quest ? `📜 ${S.quest}` : '📜 aucune quête'));
        if (S.waiting) row.appendChild(el('div', 'n', `${S.waiting.kind === 'permission' ? '✋' : '⏳'} ${S.waiting.text}`));
        else if (S.narration) row.appendChild(el('div', 'n', `💬 ${plainText(S.narration.text).replace(/\s+/g, ' ')}`));
        if (S.objectives.length) {
          const done = S.objectives.filter((o) => o.status === 'completed').length;
          const cur = S.objectives.find((o) => o.status === 'in_progress');
          const obj = el('div', 'obj');
          const bar = el('div', 'bar'); const fill = el('span'); fill.style.width = `${(done / S.objectives.length) * 100}%`; bar.appendChild(fill);
          obj.append(bar, el('span', null, `${done}/${S.objectives.length}`), el('span', 'cur', cur ? `⚔ ${cur.active || cur.text}` : done === S.objectives.length ? '🏆 tous vaincus' : ''));
          row.appendChild(obj);
        }
        const s = S.stats;
        row.appendChild(el('div', 'meta', `Niv. ${s.level} · ${s.forged} forges · ${s.spells} sorts · ${s.fails} échecs · ${S.files.size} fichiers visités`));
        card.appendChild(row);
      });
      grid.appendChild(card);
    }
    box.appendChild(grid);
  }
  $('realm').addEventListener('click', (e) => {
    const row = e.target.closest('.hero-row');
    if (!row) return;
    if (e.target.closest('.forget')) fetch(`/forget?id=${encodeURIComponent(row.dataset.id)}`, { method: 'POST' }).catch(() => {});
    else setView('dungeon', row.dataset.id);
  });
  const pl = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  // ================== onglets ==================
  let tabsSig = '';
  function renderTabs(now) {
    const recs = [...sessions.values()].sort((a, b) => (a.S.firstAt || 0) - (b.S.firstAt || 0));
    const perProject = new Map();
    const visible = recs.filter((r) => {
      const st = M.status(r.S, now);
      return r.id === view.id || !['sleep', 'ended'].includes(st) || now - (r.S.lastAt || 0) < 2 * 3600 * 1000;
    });
    for (const r of visible) perProject.set(r.S.project, (perProject.get(r.S.project) || 0) + 1);
    const counter = new Map();
    const items = visible.map((r) => {
      const st = M.status(r.S, now);
      const n = (counter.get(r.S.project) || 0) + 1; counter.set(r.S.project, n);
      const done = r.S.objectives.filter((o) => o.status === 'completed').length;
      return { id: r.id, st, name: perProject.get(r.S.project) > 1 ? `${r.S.project} ·${n}` : r.S.project, prog: r.S.objectives.length ? `${done}/${r.S.objectives.length}` : '', allies: M.activeCompanions(r.S).length };
    });
    const waiting = items.filter((i) => i.st === 'permission').length;
    const sig = `${view.mode}|${view.id}|${waiting}|` + items.map((i) => `${i.id}${i.st}${i.name}${i.prog}${i.allies}`).join(',');
    if (sig === tabsSig) return;
    tabsSig = sig;
    const box = $('tabs');
    box.innerHTML = '';
    const home = el('button', `tab${view.mode === 'realm' ? ' on' : ''}`);
    home.dataset.id = '__realm';
    home.append(el('span', null, '🏰 Royaume'));
    if (waiting) home.append(el('span', 'badge', String(waiting)));
    box.appendChild(home);
    for (const i of items) {
      const t = el('button', `tab st-${i.st}${view.id === i.id ? ' on' : ''}`);
      t.dataset.id = i.id;
      t.title = `${STATUS[i.st].label}`;
      t.append(el('span', 'dot'), el('span', null, i.name));
      if (i.prog) t.append(el('span', 'prog', i.prog));
      if (i.allies) t.append(el('span', 'allies', `🧝${i.allies}`));
      box.appendChild(t);
    }
  }
  $('tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    if (t.dataset.id === '__realm') setView('realm'); else setView('dungeon', t.dataset.id);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view.mode === 'dungeon') setView('realm'); });

  // ================== chronique ==================
  const logEl = $('log');
  const log = {
    sid: null, mode: null, nodes: new Map(), newsSig: '',
    reset() { this.sid = null; this.mode = null; this.nodes.clear(); this.newsSig = ''; logEl.innerHTML = ''; },
  };

  function isLive(S, e, now) {
    if (e.type === 'phase') return S.phase === e && now - e.t2 < M.IDLE_GAP_MS + 4000;
    if (e.type === 'companion') return e.open;
    return false;
  }
  function visibleEntry(S, e, now) { return filter === 'all' || e.imp === 1 || isLive(S, e, now); }

  function entryHead(e, live) {
    const head = el('span', 'head');
    head.append(el('time', null, clock(e.t)), document.createTextNode(`${e.icon || '•'} `));
    if (e.title) head.append(document.createTextNode(e.title));
    if (live) head.append(el('i', 'live-dot'));
    return head;
  }

  function buildEntry(S, e, now, prevEl) {
    const live = isLive(S, e, now);
    const cls = ['entry', e.type];
    if (e.imp !== 1) cls.push('minor');
    if (e.fails) cls.push('err');
    if (live) cls.push('open');
    if (e.waitKind === 'input') cls.push('input');
    const div = el('div', cls.join(' '));
    const items = e.items && e.items.length ? e.items : null;
    const fill = (box) => {
      if (e.sub) box.append(el('span', 'sub', e.sub));
      if (e.text) box.append(el('span', 'body', e.type === 'say' || e.type === 'chronicle' ? plainText(e.text) : e.text));
    };
    if (items) {
      const det = el('details');
      if (prevEl) { const old = prevEl.querySelector('details'); if (old && old.open) det.open = true; }
      const sum = el('summary');
      sum.append(entryHead(e, live));
      fill(sum);
      det.appendChild(sum);
      const ul = el('ul');
      if (e.more) ul.appendChild(el('li', null, `… ${e.more} actions plus anciennes`));
      const shown = items.slice(-150);
      if (items.length > shown.length) ul.appendChild(el('li', null, `… ${items.length - shown.length} de plus`));
      for (const it of shown) {
        const li = el('li', it.err ? 'err' : '');
        li.append(document.createTextNode(`${it.icon || '•'} `));
        if (it.cmd) li.append(el('code', null, it.text)); else li.append(document.createTextNode(it.text));
        if (it.err) { li.append(document.createTextNode(' ✖')); if (it.errText) li.append(el('span', 'why', short(it.errText, 160))); }
        ul.appendChild(li);
      }
      det.appendChild(ul);
      div.appendChild(det);
    } else {
      div.appendChild(entryHead(e, live));
      fill(div);
    }
    div.classList.toggle('hidden', !visibleEntry(S, e, now));
    return div;
  }

  function renderLog(S, now) {
    if (log.sid !== S.id || log.mode !== 'dungeon') { log.reset(); log.sid = S.id; log.mode = 'dungeon'; }
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
    const list = S.journal.slice(-400);
    const firstId = list.length ? list[0].id : Infinity;
    for (const [id, n] of log.nodes) if (id < firstId) { n.el.remove(); log.nodes.delete(id); }
    for (const e of list) {
      const n = log.nodes.get(e.id);
      const liveKey = isLive(S, e, now);
      if (!n) {
        const div = buildEntry(S, e, now);
        logEl.appendChild(div);
        log.nodes.set(e.id, { el: div, rev: e.rev, live: liveKey, filter });
      } else if (n.rev !== e.rev || n.live !== liveKey || n.filter !== filter) {
        const div = buildEntry(S, e, now, n.el);
        n.el.replaceWith(div);
        Object.assign(n, { el: div, rev: e.rev, live: liveKey, filter });
      }
    }
    if (!list.length && !logEl.firstChild) logEl.appendChild(el('div', 'muted-note', 'Rien encore : le héros vient d\'arriver.'));
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  // Nouvelles du royaume : l'important de toutes les sessions, mêlé par heure.
  function renderNews(now) {
    const items = [];
    for (const rec of sessions.values()) {
      for (const e of rec.S.journal.slice(-200)) {
        if (!(e.type === 'prompt' || e.type === 'wait' || e.type === 'stop' || e.type === 'objective' || e.type === 'chronicle' || (e.type === 'phase' && e.fails))) continue;
        items.push({ e, rec });
      }
    }
    items.sort((a, b) => a.e.t - b.e.t);
    const last = items.slice(-80);
    const sig = last.map((i) => `${i.rec.id}${i.e.id}${i.e.rev}`).join(',');
    if (log.mode === 'news' && sig === log.newsSig) return;
    log.reset(); log.mode = 'news'; log.newsSig = sig;
    for (const { e, rec } of last) {
      const div = el('div', `entry ${e.type}${e.fails ? ' err' : ''}${e.waitKind === 'input' ? ' input' : ''}`);
      const head = entryHead(e, false);
      const tag = el('span', 'tag', rec.S.project);
      tag.style.background = `hsl(${hash(rec.S.cwd) % 360} 45% 62%)`;
      head.insertBefore(tag, head.childNodes[1]);
      div.appendChild(head);
      if (e.type === 'prompt' || e.type === 'chronicle') div.appendChild(el('span', 'body', short(plainText(e.text), 220)));
      div.style.cursor = 'pointer';
      div.addEventListener('click', () => setView('dungeon', rec.id));
      logEl.appendChild(div);
    }
    if (!last.length) logEl.appendChild(el('div', 'muted-note', 'Aucune nouvelle pour l\'instant.'));
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setFilter(f) {
    filter = f; pref.set('filter', f);
    $('fImp').classList.toggle('on', f === 'imp'); $('fAll').classList.toggle('on', f === 'all');
    ui.dirty = true;
  }
  $('fImp').addEventListener('click', () => setFilter('imp'));
  $('fAll').addEventListener('click', () => setFilter('all'));

  // ================== panneaux ==================
  function renderQuest(S) {
    const q = $('questText');
    if (S.quest) { q.textContent = S.quest; q.classList.remove('none'); } else { q.textContent = 'Aucune quête en cours.'; q.classList.add('none'); q.classList.remove('full'); }
    const ol = $('objectives');
    const sig = JSON.stringify(S.objectives.map((o) => [o.id, o.status, o.text, o.active]));
    if (ol.dataset.sig === sig) return;
    ol.dataset.sig = sig;
    ol.innerHTML = '';
    const done = S.objectives.filter((o) => o.status === 'completed').length;
    $('objCount').textContent = S.objectives.length ? `${done}/${S.objectives.length}` : '';
    if (!S.objectives.length) { ol.appendChild(el('li', 'none', 'Aucun objectif déclaré : le héros improvise.')); return; }
    for (const o of S.objectives) {
      const li = el('li', o.status);
      li.append(el('span', 'ic', o.status === 'completed' ? '✔' : o.status === 'in_progress' ? '⚔' : '☐'), el('span', null, o.status === 'in_progress' && o.active ? o.active : o.text));
      li.title = o.text;
      ol.appendChild(li);
    }
  }
  $('questText').addEventListener('click', () => $('questText').classList.toggle('full'));

  function renderHud(S, now) {
    const s = S.stats;
    $('lvl').textContent = `NIVEAU ${s.level}`;
    $('hpTxt').textContent = `${s.hp}/100`; $('hpBar').style.width = `${s.hp}%`;
    const lo = xpFor(s.level), hi = xpFor(s.level + 1);
    $('xpTxt').textContent = `${s.xp} / ${hi}`;
    $('xpBar').style.width = `${Math.min(100, ((s.xp - lo) / (hi - lo)) * 100)}%`;
    $('sRooms').textContent = S.dirs.size; $('sForge').textContent = s.forged;
    $('sSpells').textContent = s.spells; $('sErr').textContent = s.fails;
    $('sObj').textContent = `${S.objectives.filter((o) => o.status === 'completed').length}/${S.objectives.length}`;
    $('sAllies').textContent = M.activeCompanions(S).length;
    const nar = $('narration');
    if (S.narration) {
      nar.classList.add('show');
      const txt = plainText(S.narration.text).replace(/\s*\n\s*/g, ' ');
      if ($('narrationText').textContent !== txt) $('narrationText').textContent = txt;
      $('narrationAge').textContent = ago(S.narration.t, now);
    } else nar.classList.remove('show');
    const w = $('waiting');
    w.textContent = S.waiting ? `${S.waiting.kind === 'permission' ? '✋' : '⏳'} ${S.waiting.text}` : '';
    w.classList.toggle('show', !!S.waiting);
    w.classList.toggle('input', !!S.waiting && S.waiting.kind !== 'permission');
    $('stage').classList.toggle('alert', !!S.waiting && S.waiting.kind === 'permission');
    $('follow').classList.toggle('on', cam.mode === 'follow');
    $('overview').classList.toggle('on', cam.mode === 'overview');
  }

  const ui = { dirty: true, lastTick: 0 };
  function renderUI(now) {
    renderTabs(now);
    const dungeon = view.mode === 'dungeon' && shownS();
    $('realm').classList.toggle('show', !dungeon && sessions.size > 0);
    $('empty').style.display = sessions.size ? 'none' : '';
    for (const id of ['narration', 'hud', 'mapctl', 'waiting']) $(id).style.visibility = dungeon ? '' : 'hidden';
    $('questbox').style.display = dungeon ? '' : 'none';
    $('replay').style.display = dungeon ? '' : 'none';
    $('replay').textContent = replay ? '⏹ Arrêter' : '▶ Rejouer';
    $('logTitle').textContent = dungeon ? '📖 CHRONIQUE' : '📯 NOUVELLES DU ROYAUME';
    document.querySelector('.seg').style.display = dungeon ? '' : 'none';
    if (!dungeon) { $('stage').classList.remove('alert'); renderRealm(now); renderNews(now); }
    else { const S = shownS(); renderQuest(S); renderHud(S, now); renderLog(S, now); }
    const asking = [...sessions.values()].filter((r) => r.S.waiting && r.S.waiting.kind === 'permission').map((r) => r.S.project);
    document.title = asking.length ? `✋ ${[...new Set(asking)].join(', ')} — Claude Dungeon` : 'Claude Dungeon';
  }

  // ================== rejeu ==================
  function startReplay() {
    const rec = sessions.get(view.id);
    if (!rec) return;
    const S = M.createSession(rec.id, rec.cwd);
    replay = { rec, S, i: 0, token: {} };
    anim = createAnim(S); FX.clear(); cam.snap = true; cam.mode = 'auto';
    log.reset();
    $('replay').textContent = '⏹ Arrêter';
    const token = replay.token;
    const tick = () => {
      if (!replay || replay.token !== token) return;
      const evs = rec.events;
      if (replay.i >= evs.length) { stopReplay(); return; }
      const hero = anim.actors.get('hero');
      const busy = [...anim.actors.values()].some((x) => x.queue.length > 1) || hero.queue.length > 0;
      if (busy) { setTimeout(tick, 60); return; }
      let moved = false;
      while (replay.i < evs.length && !moved) {
        const prev = objStatuses(S);
        const moves = M.reduce(S, evs[replay.i++]);
        enqueue(anim, moves, prev);
        moved = moves.some((m) => m.act !== 'say');
      }
      ui.dirty = true;
      setTimeout(tick, 40);
    };
    tick();
  }
  function stopReplay() {
    replay = null;
    $('replay').textContent = '▶ Rejouer';
    setView('dungeon', view.id, false);
    anim = createAnim(shownS()); cam.snap = true;
    log.reset(); ui.dirty = true;
  }
  $('replay').addEventListener('click', () => (replay ? stopReplay() : startReplay()));

  // ================== vitesse ==================
  $('speed').value = speed;
  $('speed').addEventListener('change', () => { speed = $('speed').value; pref.set('speed', speed); });
  setFilter(filter);

  // ================== boucle ==================
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(4, (now - last) / 16.67); last = now;
    if (!W) resize();
    const wall = Date.now();
    if (ui.dirty || wall - ui.lastTick > 1000) { ui.dirty = false; ui.lastTick = wall; renderUI(wall); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0a0f'; ctx.fillRect(0, 0, W, H);
    try {
      if (view.mode === 'dungeon' && anim) drawDungeon(now, dt);
      else for (const c of document.querySelectorAll('#realm canvas')) drawCastle(c, c.dataset.status, now);
    } catch (err) {
      // une erreur de dessin ne doit jamais figer la carte
      if (!frame.failed) { frame.failed = true; console.error('[dungeon] dessin', err); }
      if (anim) for (const act of anim.actors.values()) { act.step = null; act.queue = []; }
    }
    requestAnimationFrame(frame);
  }

  resize();
  requestAnimationFrame(frame);
  connect();
})();
