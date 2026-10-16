// Claude Dungeon — serveur sans dépendance.
// Reçoit les événements des hooks Claude Code (POST /event),
// suit le transcript JSONL de chaque session pour récupérer ce que Claude dit,
// et diffuse le tout au navigateur en Server-Sent Events (GET /stream).
// Le regroupement (phases, compagnons, carte) est calculé côté navigateur par
// public/model.js, de façon déterministe à partir de la liste d'événements.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4242);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_EVENTS_PER_SESSION = 6000;
const MAX_SESSIONS = 20;
const TRANSCRIPT_POLL_MS = 800;

// Résumé IA de fin de tâche : désactivé sauf si les deux variables sont définies.
const AI_SUMMARY = process.env.DUNGEON_AI_SUMMARY === '1' && !!process.env.ANTHROPIC_API_KEY;
const AI_MODEL = process.env.DUNGEON_AI_MODEL || 'claude-haiku-5-5';
const AI_TIMEOUT_MS = 20000;

/** @type {Map<string, any>} */
const sessions = new Map();
const clients = new Set();
let seq = 0;

// ---------- utilitaires ----------

function trunc(s, n) {
  if (s == null) return '';
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function isErrorResponse(resp) {
  if (!resp || typeof resp !== 'object') return false;
  if (resp.is_error === true || resp.isError === true) return true;
  if (resp.interrupted === true) return true;
  if (typeof resp.error === 'string' && resp.error) return true;
  if (typeof resp.exitCode === 'number' && resp.exitCode !== 0) return true;
  if (typeof resp.exit_code === 'number' && resp.exit_code !== 0) return true;
  return false;
}

const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);

function toolDetail(t, input) {
  if (t === 'Bash') return trunc(input.command, 800);
  if (t === 'Grep' || t === 'Glob') return trunc(input.pattern, 160);
  if (t === 'WebFetch') return trunc(input.url, 200);
  if (t === 'WebSearch') return trunc(input.query, 200);
  if (t === 'Task' || t === 'Agent') return trunc(input.description || input.subagent_type || '', 160);
  if (t === 'Skill') return trunc(input.skill || input.command || '', 120);
  if (t === 'TaskCreate') return trunc(input.subject, 200);
  if (t === 'TaskUpdate') return trunc([input.taskId && `#${input.taskId}`, input.status, input.subject].filter(Boolean).join(' '), 200);
  if (t === 'AskUserQuestion') {
    const q = Array.isArray(input.questions) && input.questions[0];
    return trunc((q && (q.question || q.header)) || '', 200);
  }
  if (t.startsWith('mcp__')) return t.split('__').slice(1).join(' › ');
  return '';
}

// Les prompts reçus ne viennent pas tous de l'utilisateur : retours de sous-agents,
// notifications de tâches de fond, sorties de commandes locales…
function classifyPrompt(raw) {
  let p = typeof raw === 'string' ? raw : '';
  const handback = p.match(/^\s*<agent-message\s+from="([^"]+)"[^>]*>([\s\S]*?)(?:<\/agent-message>|$)/);
  if (handback) {
    const body = handback[2]
      .replace(/^\s*\[Subagent hand-back\][^\n]*\n?/, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    return { kind: 'handback', agentId: handback[1], detail: trunc(body, 400) };
  }
  if (/^\s*<task-notification/.test(p)) {
    const pick = (tag) => { const m = p.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };
    return { kind: 'sysprompt', detail: trunc(pick('summary') || pick('status') || 'Tâche de fond terminée', 240) };
  }
  if (/^\s*<command-name>/.test(p)) {
    const name = (p.match(/<command-name>([\s\S]*?)<\/command-name>/) || [])[1] || '';
    const args = (p.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    return { kind: 'prompt', detail: trunc(`${name.trim()} ${args.trim()}`.trim(), 400) };
  }
  if (/^\s*<(local-command-|bash-input|bash-stdout|bash-stderr|system-reminder)/.test(p)) {
    return { kind: 'sysprompt', detail: trunc(p.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 200) };
  }
  // Texte collé : on garde les mots de l'utilisateur, sinon la première ligne du collage.
  let pasted = '';
  p = p.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, (_, body) => {
    if (!pasted) pasted = body.split('\n').map((l) => l.trim()).find(Boolean) || '';
    return ' ';
  });
  p = p.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim();
  if (!p && pasted) return { kind: 'prompt', detail: trunc(`📋 ${pasted}`, 400) };
  return { kind: 'prompt', detail: trunc(pasted ? `${p} (+ texte collé)` : p, 400) };
}

// ---------- objectifs (TodoWrite / TaskCreate / TaskUpdate) ----------
// Le serveur tient la liste complète par session et l'attache à l'événement :
// le navigateur n'a qu'à lire le dernier `todos` connu.

function applyTodos(s, tool, input, resp) {
  if (tool === 'TodoWrite') {
    const list = Array.isArray(input.todos) ? input.todos : [];
    s.tasks = new Map();
    list.forEach((td, i) => {
      const id = String(td.id || i + 1);
      s.tasks.set(id, { id, text: trunc(td.content || td.subject || '', 300), active: trunc(td.activeForm || '', 300), status: td.status || 'pending' });
    });
  } else if (tool === 'TaskCreate') {
    const id = String((resp && resp.task && resp.task.id) || ++s.taskSeq);
    const n = Number(id);
    if (Number.isFinite(n) && n > s.taskSeq) s.taskSeq = n;
    s.tasks.set(id, { id, text: trunc(input.subject || '', 300), active: trunc(input.activeForm || '', 300), status: 'pending' });
  } else if (tool === 'TaskUpdate') {
    const id = String(input.taskId || '');
    if (!id) return null;
    if (input.status === 'deleted') { s.tasks.delete(id); return snapshotTodos(s); }
    const cur = s.tasks.get(id) || { id, text: `Tâche #${id}`, active: '', status: 'pending' };
    if (input.subject) cur.text = trunc(input.subject, 300);
    if (input.activeForm) cur.active = trunc(input.activeForm, 300);
    if (input.status) cur.status = input.status;
    s.tasks.set(id, cur);
  } else return null;
  return snapshotTodos(s);
}

function snapshotTodos(s) {
  return [...s.tasks.values()].map((t) => ({ ...t }));
}

// ---------- normalisation ----------

// Transforme le JSON brut d'un hook en événement compact pour le front.
function normalize(raw, s) {
  const ev = {
    id: ++seq,
    t: Date.now(),
    session: s.id,
    hook: raw.hook_event_name || 'Unknown',
    tool: raw.tool_name || null,
    agent: raw.agent_id || null,
  };
  if (raw.agent_type) ev.agentType = raw.agent_type;
  if (raw.tool_use_id) ev.useId = raw.tool_use_id;
  const input = raw.tool_input || {};
  const resp = raw.tool_response;

  switch (ev.hook) {
    case 'SessionStart':
      ev.kind = 'session';
      ev.detail = raw.source || '';
      break;
    case 'SessionEnd':
      ev.kind = 'session-end';
      ev.detail = raw.reason || '';
      break;
    case 'UserPromptSubmit': {
      const c = classifyPrompt(raw.prompt);
      ev.kind = c.kind;
      ev.detail = c.detail;
      if (c.agentId) ev.agentId = c.agentId;
      break;
    }
    case 'Notification':
      ev.kind = 'notify';
      ev.detail = trunc(raw.message, 200);
      if (raw.notification_type) ev.ntype = raw.notification_type;
      break;
    case 'PermissionRequest':
      ev.kind = 'permission';
      ev.path = input.file_path || input.notebook_path || input.path || null;
      ev.detail = toolDetail(ev.tool || '', input);
      break;
    case 'Stop':
      ev.kind = 'stop';
      break;
    case 'SubagentStart':
      ev.kind = 'subagent-start';
      break;
    case 'SubagentStop':
      ev.kind = 'subagent-stop';
      break;
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      ev.kind = ev.hook === 'PreToolUse' ? 'tool-start' : 'tool-end';
      const t = ev.tool || '';
      ev.path = input.file_path || input.notebook_path || input.path || null;
      ev.detail = toolDetail(t, input);
      if (t === 'Agent' || t === 'Task') ev.subtype = input.subagent_type || null;
      if (ev.hook === 'PostToolUseFailure') {
        ev.error = true;
        ev.errorText = trunc(raw.error, 300);
        if (raw.is_interrupt) ev.interrupted = true;
      } else if (ev.hook === 'PostToolUse') {
        ev.error = isErrorResponse(resp);
        if (resp && typeof resp === 'object') {
          if ((t === 'Write' || t === 'Edit' || t === 'MultiEdit') && typeof resp.type === 'string') ev.created = resp.type === 'create';
          if ((t === 'Agent' || t === 'Task') && resp.agentId) {
            ev.agentId = resp.agentId;
            ev.async = resp.status === 'async_launched' || resp.isAsync === true;
          }
        }
        if (TODO_TOOLS.has(t) && !ev.error) {
          const todos = applyTodos(s, t, input, resp);
          if (todos) ev.todos = todos;
        }
      }
      break;
    }
    default:
      ev.kind = 'other';
      ev.detail = ev.hook;
  }
  return ev;
}

// ---------- sessions ----------

function getSession(id, cwd, transcript) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, cwd, transcript: null, offset: 0, events: [], startedAt: Date.now(), lastAt: Date.now(), tasks: new Map(), taskSeq: 0, summarizing: false };
    sessions.set(id, s);
    // On garde les N sessions les plus récentes
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
      sessions.delete(oldest.id);
    }
  }
  if (cwd) s.cwd = cwd;
  if (transcript && !s.transcript) {
    s.transcript = transcript;
    // On démarre à la fin du fichier : on ne rejoue pas l'historique du transcript,
    // sauf la dernière phrase de Claude, pour que la narration ne soit pas vide.
    try { s.offset = fs.statSync(transcript).size; } catch { s.offset = 0; }
    const last = lastAssistantText(transcript, s.offset);
    if (last) s.pendingSay = last;
  }
  return s;
}

function pushEvent(s, ev) {
  s.events.push(ev);
  if (s.events.length > MAX_EVENTS_PER_SESSION) s.events.splice(0, s.events.length - MAX_EVENTS_PER_SESSION);
  s.lastAt = ev.t;
  broadcast('event', { session: s.id, cwd: s.cwd, ev });
}

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function snapshot() {
  return [...sessions.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => ({ id: s.id, cwd: s.cwd, startedAt: s.startedAt, lastAt: s.lastAt, events: s.events }));
}

// ---------- suivi des transcripts (ce que Claude écrit) ----------

function assistantTexts(row) {
  if (!row || row.type !== 'assistant' || !row.message) return [];
  const content = Array.isArray(row.message.content) ? row.message.content : [];
  return content.filter((b) => b.type === 'text' && b.text && b.text.trim()).map((b) => b.text.trim());
}

function lastAssistantText(file, size) {
  try {
    const len = Math.min(size, 512 * 1024);
    if (!len) return null;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let row; try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row.isSidechain) continue;
      const texts = assistantTexts(row);
      if (texts.length) return texts[texts.length - 1];
    }
  } catch { /* transcript illisible : tant pis */ }
  return null;
}

function sayEvent(s, text, sidechain) {
  return { id: ++seq, t: Date.now(), session: s.id, hook: 'Transcript', kind: 'say', sidechain: !!sidechain, detail: trunc(text, 600) };
}

function pollTranscripts() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.pendingSay) { pushEvent(s, sayEvent(s, s.pendingSay, false)); s.pendingSay = null; }
    if (!s.transcript || now - s.lastAt > 30 * 60 * 1000) continue;
    let size;
    try { size = fs.statSync(s.transcript).size; } catch { continue; }
    if (size < s.offset) s.offset = 0; // fichier tronqué / recréé
    if (size === s.offset) continue;
    let chunk;
    try {
      const fd = fs.openSync(s.transcript, 'r');
      const len = Math.min(size - s.offset, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, s.offset);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch { continue; }
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl === -1) continue; // ligne incomplète, on attend
    s.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf8');
    for (const line of chunk.slice(0, lastNl).split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      for (const text of assistantTexts(row)) pushEvent(s, sayEvent(s, text, row.isSidechain));
    }
  }
}
setInterval(pollTranscripts, TRANSCRIPT_POLL_MS).unref(); // le serveur HTTP garde le process en vie

// ---------- résumé IA de fin de tâche (optionnel) ----------

function taskDigest(s) {
  let start = 0;
  for (let i = s.events.length - 1; i >= 0; i--) if (s.events[i].kind === 'prompt') { start = i; break; }
  const evs = s.events.slice(start);
  const prompt = evs[0] && evs[0].kind === 'prompt' ? evs[0].detail : '';
  const tools = evs.filter((e) => e.kind === 'tool-start');
  if (!tools.length) return null;
  const count = (pred) => tools.filter(pred).length;
  const edited = [...new Set(tools.filter((e) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(e.tool) && e.path).map((e) => e.path.split('/').pop()))];
  const fails = evs.filter((e) => e.kind === 'tool-end' && e.error).length;
  const companions = tools.filter((e) => (e.tool === 'Agent' || e.tool === 'Task') && !e.agent).map((e) => e.detail);
  const says = evs.filter((e) => e.kind === 'say' && !e.sidechain).map((e) => e.detail).slice(-4);
  const todos = [...s.tasks.values()].map((t) => `- [${t.status}] ${t.text}`).join('\n');
  return [
    `Demande de l'utilisateur : ${prompt || '(inconnue)'}`,
    todos && `Objectifs :\n${todos}`,
    `Actions : ${tools.length} outils, ${count((e) => e.tool === 'Read' || e.tool === 'Grep' || e.tool === 'Glob')} lectures/recherches, ${count((e) => e.tool === 'Bash')} commandes, ${fails} échecs.`,
    edited.length && `Fichiers modifiés : ${edited.slice(0, 15).join(', ')}`,
    companions.length && `Sous-agents : ${companions.slice(0, 8).join(' ; ')}`,
    says.length && `Derniers messages de l'assistant :\n${says.map((t) => `« ${t} »`).join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

async function summarize(s) {
  if (!AI_SUMMARY || s.summarizing) return;
  const digest = taskDigest(s);
  if (!digest) return;
  s.summarizing = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 2000,
        output_config: { effort: 'low' },
        system: "Tu es le chroniqueur d'un donjon où un héros (un assistant de code) accomplit des quêtes (des tâches de développement). Résume la quête terminée en 2 ou 3 phrases, en français, au passé, sur un ton de chronique de quête sobre. Reste fidèle aux faits fournis, n'invente rien, cite les fichiers ou résultats importants. Réponds uniquement par la chronique.",
        messages: [{ role: 'user', content: digest }],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) { console.error(`[résumé IA] HTTP ${res.status}`, data && data.error && data.error.message); return; }
    if (data.stop_reason === 'refusal') { console.error('[résumé IA] refusé par le modèle'); return; }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) pushEvent(s, { id: ++seq, t: Date.now(), session: s.id, hook: 'Chronicle', kind: 'chronicle', detail: trunc(text, 800) });
  } catch (err) {
    console.error('[résumé IA]', err.name === 'AbortError' ? 'délai dépassé' : err.message);
  } finally {
    clearTimeout(timer);
    s.summarizing = false;
  }
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/event') {
    let body = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // Les réponses d'outils peuvent être énormes : on ne garde que le début
      if (size < 512 * 1024) body += c;
    });
    req.on('end', () => {
      res.writeHead(204).end();
      let raw;
      try { raw = JSON.parse(body); } catch {
        // payload tronqué (gros tool_response) : on récupère au moins l'essentiel
        raw = salvage(body);
        if (!raw) return;
      }
      const s = getSession(raw.session_id || 'inconnue', raw.cwd, raw.transcript_path);
      const ev = normalize(raw, s);
      pushEvent(s, ev);
      if (ev.kind === 'stop' || ev.kind === 'tool-end') setTimeout(pollTranscripts, 150);
      // on laisse le temps au dernier message d'arriver dans le transcript
      if (ev.kind === 'stop' && !ev.agent) setTimeout(() => summarize(s), 1500);
    });
    return;
  }

  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  if (url.pathname === '/sessions.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, clients: clients.size, aiSummary: AI_SUMMARY }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/reset') {
    sessions.clear();
    broadcast('snapshot', []);
    res.writeHead(204).end();
    return;
  }

  // fichiers statiques
  const p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// Extrait les champs utiles d'un JSON tronqué
function salvage(body) {
  const pick = (k) => {
    const m = body.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) return undefined;
    try { return JSON.parse(`"${m[1]}"`); } catch { return undefined; }
  };
  const hook = pick('hook_event_name');
  if (!hook) return null;
  const input = {};
  for (const k of ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'description']) {
    const v = pick(k);
    if (v !== undefined) input[k] = v;
  }
  return {
    hook_event_name: hook, session_id: pick('session_id'), cwd: pick('cwd'),
    transcript_path: pick('transcript_path'), tool_name: pick('tool_name'), tool_input: input,
    tool_use_id: pick('tool_use_id'), agent_id: pick('agent_id'), agent_type: pick('agent_type'),
  };
}

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🗺️  Claude Dungeon prêt sur http://localhost:${PORT}${AI_SUMMARY ? ` (résumé IA : ${AI_MODEL})` : ''}`);
  });
}

module.exports = { classifyPrompt, normalize, applyTodos, getSession, summarize, taskDigest };
