# Claude Dungeon

Vue web qui suit en direct les sessions Claude Code : hooks → `hooks/emit.sh` → `server/server.js` (SSE) → `public/` (canvas, sans build). Le README décrit l'usage ; ce fichier garde ce qui ne se devine pas en lisant le code.

## Contraintes du projet

- **Le hook reste muet et non bloquant** : rien sur stdout (sinon c'est injecté dans le contexte de Claude), envoi `curl` en arrière-plan, sortie immédiate si le port est fermé. Ne toucher à `hooks/emit.sh` que si c'est indispensable.
- **Aucune dépendance npm, aucun build front.** Node 22 natif (`fetch` compris), fichiers servis tels quels.
- **`public/model.js` est pur et déterministe** : ni `Date.now()`, ni `Math.random()`, ni `performance.now()`. Rejeu et rechargement doivent redonner la même chronique à partir de la même liste d'événements. Le temps qui passe (inactivité, « il y a 2 min ») se calcule côté rendu (`status(S, now)`, `app.js`).
- **Le serveur enrichit, le modèle regroupe** : le serveur attache la liste complète des objectifs (`ev.todos`), classe les prompts, extrait `agentId` / `created` ; les phases, compagnons et la carte sont calculés par `model.js`.
- Le résumé IA (`summarize`) ne fait aucun appel réseau sans `DUNGEON_AI_SUMMARY=1` **et** `ANTHROPIC_API_KEY` ; l'appel vient du serveur, jamais du hook.

## Ce que les hooks envoient vraiment (vérifié sur des transcripts et charges réels)

- Les actions des sous-agents arrivent dans la session parente avec `agent_id` (et `agent_type`). Elles ne doivent pas déplacer le héros.
- `PostToolUse` de l'outil `Agent` : `tool_response = { isAsync: true, status: "async_launched", agentId, description, … }` pour un agent lancé en arrière-plan. Ce `PostToolUse` arrive tout de suite, ce n'est **pas** la fin de la mission.
- Le retour d'un sous-agent arrive comme un **`UserPromptSubmit`** dont le prompt commence par `<agent-message from="<agentId>">` + `[Subagent hand-back] …`. Ce n'est pas une demande de l'utilisateur.
- D'autres prompts techniques passent par `UserPromptSubmit` : `<task-notification>`, `<command-name>` (slash command), `<local-command-caveat>`, `<bash-input>`, et le texte collé entouré de `<pasted_content …>`.
- Beaucoup de `SubagentStop` viennent d'agents internes qui n'ont fait aucune action : les ignorer si l'agent est inconnu.
- `TaskCreate` : `tool_response = { task: { id: "1", subject } }`. `TaskUpdate` : `{ success, taskId, updatedFields, statusChange: { from, to } }` — sans le sujet. `TodoWrite` : `tool_input.todos = [{ content, activeForm, status }]` (liste complète, ids positionnels).
- `Write` / `Edit` : `tool_response.type` vaut `"create"` ou `"update"`.
- Les échecs d'outils passent par `PostToolUseFailure` (champ `error`), pas par `PostToolUse` : sans ce hook installé, aucun échec n'est vu.
- La majorité des lectures passent par `Bash` (`cat`, `sed -n`, `grep`, `ls`) plutôt que par `Read` : d'où `parseBash` dans le modèle.

## Pièges rencontrés

- **Disposition qui change pendant un déplacement** (`app.js`) : une nouvelle salle recalcule le plan ; toute salle mémorisée par un acteur doit être re-résolue par sa clé dans le plan courant (`route`, arrivée d'un pas), sinon le trajet part d'un objet périmé et la boucle de dessin plante.
- **`require('./server/server.js')` dans un test** : le minuteur de lecture des transcripts est `unref()`, sinon Node ne rend jamais la main.
- **Commandes entre guillemets** (`ddev exec '…'`, `bash -c '…'`) : à re-analyser comme une commande ; les corps de heredoc ne sont pas des commandes (sinon un `phpunit` dans un fichier écrit passe pour un test).
- Après un `dungeon restart`, les objectifs créés avant le redémarrage reviennent en « Tâche #n » au premier `TaskUpdate` (le serveur ne garde rien sur disque).

## Vérifier un changement

```bash
PORT=4299 node server/server.js &
CLAUDE_DUNGEON_PORT=4299 scripts/simulate.sh          # SPEED=0.3 pour accélérer
CLAUDE_DUNGEON_PORT=4299 node scripts/check-journal.js
```

- Un nouveau contrôle dans `check-journal.js` se voit d'abord rouge en sabotant le code couvert (ex. forcer `sameKind = false` dans `reduce`), puis vert.
- Changement de rendu : contrôle au navigateur (≥ 1440 px), console sans erreur pendant une simulation complète suivie en direct, puis `dungeon restart` pour le conteneur réel.
- Changement de l'installeur : le tester avec `HOME` et `CLAUDE_SETTINGS` pointant vers une copie jetable, deux passages (pas de doublon, autres hooks conservés). Ne pas lancer `uninstall.sh` pour tester : il arrête le conteneur.
