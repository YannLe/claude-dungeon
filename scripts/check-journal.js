#!/usr/bin/env node
// Vérifie, à partir des événements réellement reçus par le serveur, que la chronique
// de la dernière simulation (scripts/simulate.sh) est faite de phases et non d'une ligne par outil.
//   node scripts/check-journal.js            # serveur du port 4242
//   CLAUDE_DUNGEON_PORT=4299 node scripts/check-journal.js
'use strict';
const http = require('http');
const path = require('path');
const M = require(path.join(__dirname, '..', 'public', 'model.js'));

const PORT = Number(process.env.CLAUDE_DUNGEON_PORT || 4242);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '  ✔' : '  ✖'} ${label}${!ok && detail !== undefined ? `\n      → ${detail}` : ''}`);
  if (!ok) failures++;
}

function latest(list, prefix) {
  return list.filter((s) => s.id.startsWith(prefix)).sort((a, b) => b.startedAt - a.startedAt)[0];
}

function show(S) {
  for (const e of S.journal) {
    const label = e.title || `« ${(e.text || '').replace(/\s+/g, ' ').slice(0, 80)} »`;
    console.log(`    ${e.imp === 1 ? '★' : '·'} ${e.icon} ${label}${e.sub ? `  [${e.sub}]` : ''}${e.items && e.items.length ? `  (${e.items.length} détails)` : ''}`);
  }
}

(async () => {
  const list = await fetchJson(`http://127.0.0.1:${PORT}/sessions.json`);
  const a = latest(list, 'sim-shop-'), b = latest(list, 'sim-billing-');
  if (!a || !b) { console.error('❌ Aucune simulation trouvée : lance d\'abord scripts/simulate.sh'); process.exit(2); }

  const A = M.buildSession(a.id, a.cwd, a.events);
  const B = M.buildSession(b.id, b.cwd, b.events);
  const toolsA = a.events.filter((e) => e.kind === 'tool-start').length;
  const phasesA = A.journal.filter((e) => e.type === 'phase');
  const titles = A.journal.map((e) => e.title || '');

  console.log(`\n▶ ${A.project} — ${toolsA} appels d'outils → ${A.journal.length} entrées de chronique (${phasesA.length} phases)`);
  show(A);
  console.log('\n  Contrôles :');
  check('moins d\'une phase pour deux appels d\'outils', phasesA.length * 2 < toolsA, `${phasesA.length} phases pour ${toolsA} appels`);
  check('la rafale de lectures tient en une phase (7 fichiers, 2 recherches)', titles.some((t) => /^Explore .* — 7 fichiers lus, 2 recherches$/.test(t)), titles.filter((t) => t.startsWith('Explore')).join(' | '));
  check('l\'inactivité coupe l\'exploration en deux phases', phasesA.filter((e) => e.fam === 'explore').length >= 2);
  check('les éditions sont regroupées (Forge 4 fichiers, 1 créé)', titles.some((t) => /^Forge 4 fichiers.*\(1 créé\)$/.test(t)), titles.filter((t) => t.startsWith('Forge')).join(' | '));
  check('le test rouge est une phase importante avec son échec', A.journal.some((e) => e.fam === 'test' && e.fails === 1 && e.imp === 1));
  check('le test qui repasse est dans une phase de tests sans échec', A.journal.some((e) => e.fam === 'test' && e.fails === 0 && e.items.length === 2));
  check('la demande de permission apparaît une seule fois', A.journal.filter((e) => e.type === 'wait' && e.waitKind === 'permission').length === 1);
  check('le compagnon a une entrée unique, revenue avec 4 actions', A.journal.filter((e) => e.type === 'companion').length === 1 && /^Mission accomplie : Relire le diff du filtre — 4 actions$/.test(A.journal.find((e) => e.type === 'companion').title), (A.journal.find((e) => e.type === 'companion') || {}).title);
  check('le retour du compagnon n\'est pas pris pour une quête', A.quest && !A.quest.includes('agent-message'), A.quest);
  check('les 4 objectifs TodoWrite sont vaincus', A.objectives.length === 4 && A.objectives.every((o) => o.status === 'completed'), JSON.stringify(A.objectives.map((o) => o.status)));
  check('la narration est le dernier message de Claude', A.narration && A.narration.text.startsWith("C'est fait"), A.narration && A.narration.text);
  check('la quête est accomplie et le héros attend une réponse', A.stopped && A.waiting && A.waiting.kind === 'input', JSON.stringify(A.waiting));
  check('le fichier créé est marqué « créé » sur la carte', (A.files.get('src/Form/CategoryFilterType.php') || {}).state === 'created');
  check('les lectures Bash allument leurs salles', A.files.has('templates/product/list.html.twig'));

  console.log(`\n▶ ${B.project} — ${b.events.filter((e) => e.kind === 'tool-start').length} appels d'outils → ${B.journal.length} entrées`);
  show(B);
  console.log('\n  Contrôles :');
  check('TaskCreate / TaskUpdate donnent 3 objectifs vaincus', B.objectives.length === 3 && B.objectives.every((o) => o.status === 'completed'), JSON.stringify(B.objectives));
  check('les TaskCreate consécutifs forment une seule entrée « Fixe 3 objectifs »', B.journal.filter((e) => e.type === 'objectives').length === 1 && B.journal.some((e) => e.title === 'Fixe 3 objectifs'), B.journal.filter((e) => e.type === 'objectives').map((e) => e.title).join(' | '));
  check('les deux sessions parallèles ne se mélangent pas', ![...A.files.keys()].some((k) => k.includes('Invoice')) && ![...B.files.keys()].some((k) => k.includes('Product')));
  check('le rejeu donne la même chronique (déterminisme)', JSON.stringify(M.buildSession(a.id, a.cwd, a.events).journal.map((e) => [e.title, e.text, e.imp])) === JSON.stringify(A.journal.map((e) => [e.title, e.text, e.imp])));

  console.log(failures ? `\n❌ ${failures} contrôle(s) en échec` : '\n✅ Tous les contrôles passent');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('❌', err.message); process.exit(2); });
