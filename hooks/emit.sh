#!/usr/bin/env bash
# Hook Claude Code → Claude Dungeon.
# - Ne bloque jamais Claude : envoi en arrière-plan, timeout court.
# - N'écrit rien sur stdout : rien n'est injecté dans le contexte, zéro token.
# - Si le serveur est éteint, le curl échoue en silence.

PORT="${CLAUDE_DUNGEON_PORT:-4242}"

# Coupe-circuit rapide : si personne n'écoute, on sort sans même lire la suite.
# (bash /dev/tcp : pas de process externe, quasi instantané)
if ! (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  cat >/dev/null
  exit 0
fi

payload="$(cat)"

(
  printf '%s' "$payload" | curl -s -m 1 -X POST \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    "http://127.0.0.1:${PORT}/event"
) >/dev/null 2>&1 &
disown 2>/dev/null

exit 0
