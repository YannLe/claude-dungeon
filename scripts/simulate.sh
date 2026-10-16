#!/usr/bin/env bash
# Rejoue deux fausses sessions Claude Code en parallèle à travers le vrai hook (hooks/emit.sh).
#
#   scripts/simulate.sh                       # vers le serveur du port 4242
#   CLAUDE_DUNGEON_PORT=4299 scripts/simulate.sh
#   SPEED=0.3 scripts/simulate.sh             # plus rapide (multiplie les pauses)
#   IDLE_PAUSE=10 scripts/simulate.sh         # pause qui doit couper une phase d'exploration
#
# Session A « demo-shop » : prompt, objectifs TodoWrite qui évoluent, lectures en rafale,
# éditions, test rouge puis vert, demande de permission, compagnon, fin de tâche,
# messages de Claude écrits dans un faux transcript.
# Session B « api-facturation » : objectifs TaskCreate / TaskUpdate, en même temps.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$DIR/hooks/emit.sh"
PORT="${CLAUDE_DUNGEON_PORT:-4242}"
SPEED="${SPEED:-1}"
IDLE_PAUSE="${IDLE_PAUSE:-10}"
export CLAUDE_DUNGEON_PORT="$PORT"

command -v jq >/dev/null || { echo "❌ jq manquant"; exit 1; }
curl -fs -m 1 "http://127.0.0.1:${PORT}/health" >/dev/null || { echo "❌ Aucun serveur sur le port ${PORT}"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
RUN="$(date +%s)"

pause() { sleep "$(awk -v s="$1" -v k="$SPEED" 'BEGIN { v = s * k; if (v < 0.15) v = 0.15; print v }')"; }

# ---------- émission ----------
# usage interne : SID, CWD et TRANSCRIPT sont propres à chaque session (variables locales du sous-shell)
emit() { printf '%s' "$1" | "$HOOK"; }

base() { jq -nc --arg s "$SID" --arg c "$CWD" --arg t "$TRANSCRIPT" --arg h "$1" '{session_id: $s, cwd: $c, transcript_path: $t, hook_event_name: $h}'; }

# tool <nom> <input json> [réponse json] [agent_id]
tool() {
  local name="$1" input="$2" resp="${3:-}" agent="${4:-}" use="toolu_${RANDOM}${RANDOM}"
  [ -n "$resp" ] || resp='{}'
  local extra='{}'
  [ -n "$agent" ] && extra="$(jq -nc --arg a "$agent" '{agent_id: $a, agent_type: "general-purpose"}')"
  emit "$(base PreToolUse | jq -c --arg n "$name" --argjson i "$input" --arg u "$use" --argjson x "$extra" '. + {tool_name: $n, tool_input: $i, tool_use_id: $u} + $x')"
  pause 0.25
  emit "$(base PostToolUse | jq -c --arg n "$name" --argjson i "$input" --argjson r "$resp" --arg u "$use" --argjson x "$extra" '. + {tool_name: $n, tool_input: $i, tool_response: $r, tool_use_id: $u} + $x')"
  pause 0.2
}

# fail <nom> <input json> <message d'erreur>
fail() {
  local name="$1" input="$2" err="$3" use="toolu_${RANDOM}${RANDOM}"
  emit "$(base PreToolUse | jq -c --arg n "$name" --argjson i "$input" --arg u "$use" '. + {tool_name: $n, tool_input: $i, tool_use_id: $u}')"
  pause 0.6
  emit "$(base PostToolUseFailure | jq -c --arg n "$name" --argjson i "$input" --arg u "$use" --arg e "$err" '. + {tool_name: $n, tool_input: $i, tool_use_id: $u, error: $e}')"
  pause 0.2
}

read_() { tool Read "$(jq -nc --arg p "$CWD/$1" '{file_path: $p}')" '{"type":"text"}'; }
edit_() { tool Edit "$(jq -nc --arg p "$CWD/$1" '{file_path: $p, old_string: "a", new_string: "b"}')" "$(jq -nc --arg p "$CWD/$1" '{type: "update", filePath: $p}')"; }
write_() { tool Write "$(jq -nc --arg p "$CWD/$1" '{file_path: $p, content: "<?php"}')" "$(jq -nc --arg p "$CWD/$1" '{type: "create", filePath: $p}')"; }
bash_() { tool Bash "$(jq -nc --arg c "$1" '{command: $c}')" '{"stdout":"ok","stderr":"","interrupted":false}'; }
todos() { tool TodoWrite "$(jq -nc --argjson t "$1" '{todos: $t}')" '{}'; }
prompt() { emit "$(base UserPromptSubmit | jq -c --arg p "$1" '. + {prompt: $p}')"; pause 0.4; }
say() {
  jq -nc --arg t "$1" '{type: "assistant", isSidechain: false, message: {role: "assistant", content: [{type: "text", text: $t}]}}' >> "$TRANSCRIPT"
  pause 1.2 # le serveur lit le transcript toutes les 800 ms
}
todo() { jq -nc --arg c "$1" --arg a "$2" --arg s "$3" '{content: $c, activeForm: $a, status: $s}'; }
todolist() { jq -sc '.' ; }

# ---------- session A : demo-shop ----------
session_a() {
  SID="sim-shop-$RUN"; CWD="$HOME/Projets/demo-shop"; TRANSCRIPT="$TMP/shop.jsonl"; : > "$TRANSCRIPT"
  emit "$(base SessionStart | jq -c '. + {source: "startup"}')"; pause 0.3
  prompt "Ajoute un filtre par catégorie sur la liste des produits, avec un test"
  say "Je regarde d'abord comment la liste des produits est construite, du contrôleur jusqu'au dépôt."

  local T1 T2 T3 T4
  T1="Comprendre la construction de la liste"; T2="Ajouter le filtre catégorie"; T3="Écrire et faire passer le test"; T4="Vérifier la migration"
  todos "$( { todo "$T1" "Exploration de la liste" in_progress; todo "$T2" "Ajout du filtre" pending; todo "$T3" "Écriture du test" pending; todo "$T4" "Vérification de la migration" pending; } | todolist)"

  # rafale de lectures
  read_ src/Controller/ProductController.php
  read_ src/Repository/ProductRepository.php
  read_ src/Repository/CategoryRepository.php
  tool Grep "$(jq -nc --arg p "$CWD/src" '{pattern: "findForList", path: $p}')" '{}'
  read_ src/Entity/Product.php
  read_ src/Entity/Category.php
  bash_ "cat templates/product/list.html.twig | head -60"
  tool Glob "$(jq -nc --arg p "$CWD/tests" '{pattern: "**/*Product*Test.php", path: $p}')" '{}'
  read_ tests/Repository/ProductRepositoryTest.php

  # silence : la phase d'exploration doit se fermer, la suivante en ouvrir une nouvelle
  sleep "$IDLE_PAUSE"
  read_ config/packages/doctrine.yaml
  bash_ "grep -rn 'category' src/Form/ | head -20"

  say "La requête vient de ProductRepository::findForList. J'ajoute un paramètre catégorie et le formulaire de filtre."
  todos "$( { todo "$T1" "Exploration de la liste" completed; todo "$T2" "Ajout du filtre" in_progress; todo "$T3" "Écriture du test" pending; todo "$T4" "Vérification de la migration" pending; } | todolist)"

  # forge
  edit_ src/Repository/ProductRepository.php
  edit_ src/Controller/ProductController.php
  write_ src/Form/CategoryFilterType.php
  edit_ templates/product/list.html.twig

  todos "$( { todo "$T1" "Exploration de la liste" completed; todo "$T2" "Ajout du filtre" completed; todo "$T3" "Écriture du test" in_progress; todo "$T4" "Vérification de la migration" pending; } | todolist)"
  write_ tests/Repository/ProductFilterTest.php

  # test rouge
  fail Bash '{"command":"ddev exec bin/phpunit tests/Repository"}' "Exit code 1
FAILURES! Tests: 12, Assertions: 31, Failures: 1. ProductFilterTest::testEmptyCategory"
  say "Un test échoue : le filtre ignore les catégories vides. Je corrige la condition dans le dépôt."
  edit_ src/Repository/ProductRepository.php
  bash_ "ddev exec bin/phpunit tests/Repository"
  bash_ "ddev exec vendor/bin/phpstan analyse src"

  todos "$( { todo "$T1" "Exploration de la liste" completed; todo "$T2" "Ajout du filtre" completed; todo "$T3" "Écriture du test" completed; todo "$T4" "Vérification de la migration" in_progress; } | todolist)"

  # demande de permission
  local use="toolu_perm$RANDOM" cmd="ddev exec bin/console doctrine:migrations:migrate --no-interaction"
  emit "$(base PreToolUse | jq -c --arg c "$cmd" --arg u "$use" '. + {tool_name: "Bash", tool_input: {command: $c}, tool_use_id: $u}')"; pause 0.3
  emit "$(base PermissionRequest | jq -c --arg c "$cmd" --arg u "$use" '. + {tool_name: "Bash", tool_input: {command: $c}, tool_use_id: $u}')"; pause 0.3
  emit "$(base Notification | jq -c '. + {message: "Claude needs your permission to use Bash", notification_type: "permission_prompt"}')"
  pause 4
  emit "$(base PostToolUse | jq -c --arg c "$cmd" --arg u "$use" '. + {tool_name: "Bash", tool_input: {command: $c}, tool_response: {stdout: "[OK] Already at the latest version", stderr: "", interrupted: false}, tool_use_id: $u}')"
  pause 0.4

  # compagnon : relecture du diff
  local agent="asim${RANDOM}${RANDOM}" ause="toolu_agent$RANDOM"
  emit "$(base PreToolUse | jq -c --arg u "$ause" '. + {tool_name: "Agent", tool_input: {description: "Relire le diff du filtre", subagent_type: "general-purpose", prompt: "…"}, tool_use_id: $u}')"; pause 0.3
  emit "$(base PostToolUse | jq -c --arg u "$ause" --arg a "$agent" '. + {tool_name: "Agent", tool_input: {description: "Relire le diff du filtre", subagent_type: "general-purpose"}, tool_response: {isAsync: true, status: "async_launched", agentId: $a, description: "Relire le diff du filtre"}, tool_use_id: $u}')"
  pause 0.4
  tool Bash '{"command":"git diff --stat"}' '{"stdout":"4 files changed"}' "$agent"
  tool Read "$(jq -nc --arg p "$CWD/src/Repository/ProductRepository.php" '{file_path: $p}')" '{}' "$agent"
  tool Read "$(jq -nc --arg p "$CWD/src/Form/CategoryFilterType.php" '{file_path: $p}')" '{}' "$agent"
  tool Read "$(jq -nc --arg p "$CWD/tests/Repository/ProductFilterTest.php" '{file_path: $p}')" '{}' "$agent"
  emit "$(base SubagentStop | jq -c --arg a "$agent" '. + {agent_id: $a, agent_type: "general-purpose"}')"; pause 0.3
  emit "$(base UserPromptSubmit | jq -c --arg a "$agent" '. + {prompt: ("<agent-message from=\"" + $a + "\">\n[Subagent hand-back] The text below is the final report of a subagent.\nRAS : le filtre est correct, le test couvre la catégorie vide.\n</agent-message>")}')"
  pause 0.4

  todos "$( { todo "$T1" "Exploration de la liste" completed; todo "$T2" "Ajout du filtre" completed; todo "$T3" "Écriture du test" completed; todo "$T4" "Vérification de la migration" completed; } | todolist)"
  say "C'est fait : le filtre par catégorie est en place, la migration est à jour et les 12 tests passent."
  emit "$(base Stop)"; pause 2
  emit "$(base Notification | jq -c '. + {message: "Claude is waiting for your input", notification_type: "idle_prompt"}')"
}

# ---------- session B : api-facturation ----------
session_b() {
  SID="sim-billing-$RUN"; CWD="$HOME/Projets/api-facturation"; TRANSCRIPT="$TMP/billing.jsonl"; : > "$TRANSCRIPT"
  pause 1.5
  emit "$(base SessionStart | jq -c '. + {source: "startup"}')"; pause 0.3
  prompt "Corrige l'arrondi de la TVA sur les factures multi-taux"
  say "Je pose les étapes avant de toucher au calcul."
  tool TaskCreate '{"subject":"Reproduire l'\''écart d'\''arrondi","description":"…","activeForm":"Reproduction de l'\''écart"}' '{"task":{"id":"1","subject":"Reproduire l'\''écart d'\''arrondi"}}'
  tool TaskCreate '{"subject":"Corriger le calcul par ligne","description":"…","activeForm":"Correction du calcul"}' '{"task":{"id":"2","subject":"Corriger le calcul par ligne"}}'
  tool TaskCreate '{"subject":"Ajouter un test multi-taux","description":"…","activeForm":"Ajout du test"}' '{"task":{"id":"3","subject":"Ajouter un test multi-taux"}}'
  tool TaskUpdate '{"taskId":"1","status":"in_progress"}' '{"success":true,"taskId":"1","updatedFields":["status"]}'
  read_ src/Invoice/VatCalculator.php
  read_ src/Invoice/InvoiceLine.php
  bash_ "sed -n 1,80p src/Invoice/Totals.php"
  tool TaskUpdate '{"taskId":"1","status":"completed"}' '{"success":true,"taskId":"1","updatedFields":["status"]}'
  tool TaskUpdate '{"taskId":"2","status":"in_progress"}' '{"success":true,"taskId":"2","updatedFields":["status"]}'
  say "L'arrondi est fait sur le total au lieu de chaque ligne. Je le déplace dans InvoiceLine."
  edit_ src/Invoice/VatCalculator.php
  edit_ src/Invoice/InvoiceLine.php
  tool TaskUpdate '{"taskId":"2","status":"completed"}' '{"success":true,"taskId":"2","updatedFields":["status"]}'
  tool TaskUpdate '{"taskId":"3","status":"in_progress"}' '{"success":true,"taskId":"3","updatedFields":["status"]}'
  write_ tests/Invoice/MultiRateVatTest.php
  bash_ "vendor/bin/phpunit tests/Invoice"
  tool TaskUpdate '{"taskId":"3","status":"completed"}' '{"success":true,"taskId":"3","updatedFields":["status"]}'
  say "Corrigé : l'arrondi se fait désormais ligne par ligne, et le test multi-taux passe."
  emit "$(base Stop)"
}

echo "⚔  Simulation vers le port ${PORT} (SPEED=${SPEED}, pause d'inactivité ${IDLE_PAUSE} s)…"
session_a & A=$!
session_b & B=$!
wait "$A" "$B"
echo "🏁 Terminé : sessions sim-shop-$RUN et sim-billing-$RUN"
