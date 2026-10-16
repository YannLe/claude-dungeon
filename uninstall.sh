#!/usr/bin/env bash
# Retire proprement tout ce que install.sh a ajouté.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
HOOK="$DIR/hooks/emit.sh"

if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "$SETTINGS.bak-dungeon-uninstall-$(date +%Y%m%d-%H%M%S)"
  tmp="$(mktemp)"
  jq --arg cmd "$HOOK" '
    if .hooks then
      .hooks |= (
        with_entries(
          .value |= ( map(.hooks |= map(select(.command != $cmd))) | map(select((.hooks | length) > 0)) )
        )
        | with_entries(select((.value | length) > 0))
      )
      | if (.hooks | length) == 0 then del(.hooks) else . end
    else . end
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  echo "✅ Hooks retirés de $SETTINGS"
fi

rm -f "$HOME/.local/bin/dungeon" "$HOME/.claude/commands/dungeon.md"
"$DIR/dungeon" off >/dev/null 2>&1 || true
echo "✅ Commande et slash command supprimés, conteneur arrêté"
