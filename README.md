# ⚔ Claude Dungeon

Suis tes sessions Claude Code comme un dungeon crawler. Tu vois l'intention et l'avancement plutôt que chaque appel d'outil : où en est chaque session, ce qui est à faire, en cours ou fait, et ce que Claude est en train de faire.

## Ce que tu vois

**Le Royaume** : une carte par projet, un héros par session.
- État de chaque héros : ⚔ en quête, ✋ attend ta permission, ⏳ attend ta réponse, ✔ quête accomplie, 💤 endormi.
- La demande en cours, la dernière phrase de Claude, l'objectif en cours et la barre d'avancement.
- À droite, les nouvelles du royaume : prompts, permissions, objectifs vaincus, échecs et fins de quête de toutes les sessions, dans l'ordre.
- Une session ne prend jamais la place d'une autre : chacune a son onglet, et la vue ne change que quand tu cliques.

**Le Donjon** : une session en détail.
- Une salle par dossier, reliées par des couloirs qui suivent l'arborescence. Les dossiers intermédiaires vides sont fusionnés (`api/src/Entity`) et ce qui est hors du projet vit dans la branche « ↗ ».
- Les fichiers sont des dalles : violettes quand elles sont lues, dorées quand elles sont modifiées, vertes quand elles sont créées. Le survol donne le chemin et le nombre de lectures.
- Le héros marche dans les couloirs : il remonte jusqu'au dossier commun puis redescend.
- Les compagnons (sous-agents) ont leur propre sprite et leur propre trajet ; le héros ne bouge que pour ses propres actions.
- Les objectifs (TodoWrite, TaskCreate, TaskUpdate) sont des monstres. À faire, ils dorment dans l'Antre des objectifs. En cours, ils suivent le héros, qui les combat. Faits, ils laissent un coffre.
- En haut, « Ce que fait le héros » affiche le dernier message de Claude.

**La chronique** (à droite) :
- Les actions consécutives de même nature forment une seule phase : « Explore src/Repository — 6 fichiers lus, 2 recherches », « Forge 3 fichiers (1 créé) », « Lance les tests (2 sorts, 1 échec) ». Un clic déplie le détail.
- Une phase se ferme quand le type d'action change, quand Claude écrit un message, ou après 8 s sans action.
- Les commandes Bash de lecture (`cat`, `sed -n`, `grep`, `ls`…) comptent comme de l'exploration et allument les salles des fichiers cités.
- **Important** (par défaut) montre le prompt, les objectifs, les messages de Claude, les fichiers forgés, les échecs, les permissions et la fin de quête. La phase en cours reste visible. **Tout** ajoute lectures, recherches et commandes réussies.

**Rythme** : chaque déplacement dure au moins 1 s, 600 ms ou 300 ms selon le réglage calme, normal ou rapide, qui est mémorisé dans le navigateur. Quand la file s'allonge, le héros saute les étapes intermédiaires au lieu d'accélérer.

**▶ Rejouer** rejoue la session affichée au rythme choisi. Rejouer ou recharger la page donne exactement la même chronique : tout est recalculé à partir de la liste d'événements.

Raccourcis : molette pour zoomer, glisser pour déplacer la carte, double-clic pour revenir au cadrage automatique, 🎯 pour suivre le héros, 🗺 pour la vue d'ensemble, Échap pour revenir au Royaume.

**Coût en tokens : zéro.** Les hooks ne font qu'un `curl` silencieux en arrière-plan, rien n'est renvoyé à Claude.

## Installation (Ubuntu)

Prérequis : Docker (avec compose 2.24 ou plus), `jq`, `curl`.

```bash
cd ~/outils    # le chemin du dossier est inscrit dans les hooks
./install.sh
```

Puis **redémarre Claude Code** (les hooks sont lus au démarrage).

`install.sh` :
- ajoute 10 hooks dans `~/.claude/settings.json` (SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, SubagentStop), en gardant tes réglages et en faisant une sauvegarde `settings.json.bak-dungeon-…` ;
- crée la commande `dungeon` dans `~/.local/bin` ;
- crée le slash command `/dungeon` dans Claude Code.

Il peut être relancé sans risque, sans créer de doublons. Après une mise à jour qui ajoute des hooks, relance-le puis redémarre Claude Code.

## Utilisation

```bash
dungeon          # démarre le conteneur et ouvre http://localhost:4242
dungeon off      # arrête tout
dungeon restart  # reconstruit le conteneur après une mise à jour du code
dungeon status
dungeon logs
dungeon reset    # vide les sessions en mémoire
```

Tu peux aussi taper `/dungeon` (ou `/dungeon off`) directement dans Claude Code. Ça coûte quelques tokens, contrairement à l'alias.

Quand le conteneur est éteint, les hooks détectent que le port est fermé et sortent tout de suite : environ 5 ms par action, rien de perceptible.

Pour changer de port : `export CLAUDE_DUNGEON_PORT=4343`, à mettre dans ton `.bashrc` pour que le hook et la commande `dungeon` le voient tous les deux.

## Résumé IA de fin de quête (facultatif, désactivé par défaut)

À chaque fin de tâche, le serveur peut demander à Claude Haiku une chronique de 2-3 phrases, affichée dans la chronique.

```bash
cp .env.example .env    # puis renseigne ANTHROPIC_API_KEY
dungeon restart
```

- L'appel est fait par le serveur, jamais par le hook.
- Sans `DUNGEON_AI_SUMMARY=1` **et** `ANTHROPIC_API_KEY`, aucun appel réseau n'est fait.
- Une fois activé, sont envoyés à l'API Anthropic : le prompt, la liste des objectifs, le nom des fichiers modifiés, le nombre d'actions et les derniers messages de Claude. Le contenu des fichiers n'est pas envoyé.
- `.env` n'est pas versionné (voir `.gitignore`).

## Tester sans Claude

```bash
PORT=4299 node server/server.js &              # serveur de test
CLAUDE_DUNGEON_PORT=4299 scripts/simulate.sh   # deux fausses sessions en parallèle
CLAUDE_DUNGEON_PORT=4299 node scripts/check-journal.js
```

`simulate.sh` rejoue, via le vrai `hooks/emit.sh`, une session avec prompt, objectifs qui évoluent, lectures en rafale, éditions, test rouge puis vert, demande de permission, compagnon et fin de tâche, plus une seconde session avec TaskCreate et TaskUpdate. `check-journal.js` vérifie que la chronique est faite de phases et non d'une ligne par outil, que les deux sessions ne se mélangent pas et que le rejeu est identique. `SPEED=0.3` accélère la simulation.

## Désinstallation

```bash
./uninstall.sh
```

Il retire uniquement les hooks du donjon (tes autres hooks sont conservés), la commande et le slash command, puis arrête le conteneur.

## Comment ça marche

```
Claude Code ── hooks → hooks/emit.sh (curl muet, en arrière-plan) ──▶ conteneur :4242 ── SSE ──▶ navigateur
     └── transcript ~/.claude/projects/*.jsonl ── (volume en lecture seule) ──┘
```

- `server/server.js` : Node pur, sans dépendance. Il reçoit les événements, tient la liste complète des objectifs, trie les prompts (retours de sous-agents, notifications…), suit le transcript pour récupérer le texte de Claude et diffuse en Server-Sent Events. Il garde en mémoire les 20 dernières sessions, donc recharger la page ne perd rien. `GET /sessions.json` renvoie l'état brut.
- `public/model.js` : le modèle, pur et déterministe. Il transforme la liste d'événements en quête, objectifs, compagnons, carte et chronique. Il est chargé tel quel par le navigateur et par Node pour les tests.
- `public/app.js` et `public/index.html` : rendu canvas et panneaux, sans build.
- Le serveur n'écoute que sur `127.0.0.1`.

## Limites connues

- Les sessions ne vivent qu'en mémoire : `dungeon restart` ou `dungeon off` les efface.
- Le rattachement d'un sous-agent à son lancement est exact quand l'outil Agent rend son `agentId`. Entre-temps, il est supposé dans l'ordre des lancements.
- La classification des commandes Bash est une lecture de la commande, sans l'exécuter : une commande inhabituelle peut être classée « sort » au lieu d'« exploration ».
