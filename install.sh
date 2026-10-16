#!/usr/bin/env bash
# Installe Claude Dungeon :
#  - ajoute les hooks dans ~/.claude/settings.json (avec sauvegarde)
#  - met la commande `dungeon` dans ~/.local/bin
#  - ajoute le slash command /dungeon dans Claude Code
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
HOOK="$DIR/hooks/emit.sh"
EVENTS=(SessionStart SessionEnd UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure PermissionRequest Notification Stop SubagentStop)
# événements d'outils : ils prennent un matcher
TOOL_EVENTS=" PreToolUse PostToolUse PostToolUseFailure PermissionRequest "

command -v jq >/dev/null || { echo "❌ jq manquant : sudo apt install jq"; exit 1; }
command -v curl >/dev/null || { echo "❌ curl manquant : sudo apt install curl"; exit 1; }

chmod +x "$HOOK" "$DIR/dungeon" "$DIR/uninstall.sh"

mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
jq empty "$SETTINGS" 2>/dev/null || { echo "❌ $SETTINGS n'est pas un JSON valide, je n'y touche pas."; exit 1; }

BACKUP="$SETTINGS.bak-dungeon-$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$BACKUP"

tmp="$(mktemp)"
cp "$SETTINGS" "$tmp"
for ev in "${EVENTS[@]}"; do
  case "$TOOL_EVENTS" in *" $ev "*) tool=true ;; *) tool=false ;; esac
  jq --arg ev "$ev" --arg cmd "$HOOK" --argjson tool "$tool" '
    .hooks //= {}
    | .hooks[$ev] //= []
    | if any(.hooks[$ev][]?.hooks[]?; .command == $cmd) then .
      else .hooks[$ev] += [
        (if $tool then {matcher: "*"} else {} end)
        + {hooks: [{type: "command", command: $cmd, timeout: 5}]}
      ]
      end
  ' "$tmp" > "$tmp.new" && mv "$tmp.new" "$tmp"
done
mv "$tmp" "$SETTINGS"
echo "✅ Hooks ajoutés dans $SETTINGS (sauvegarde : $BACKUP)"

mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/dungeon" "$HOME/.local/bin/dungeon"
echo "✅ Commande 'dungeon' installée dans ~/.local/bin"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "⚠️  ~/.local/bin n'est pas dans ton PATH, ajoute-le dans ton ~/.bashrc";; esac

mkdir -p "$HOME/.claude/commands"
cat > "$HOME/.claude/commands/dungeon.md" <<EOF
---
description: Ouvre (ou ferme avec "off") la vue donjon de cette session
allowed-tools: Bash($DIR/dungeon:*)
---
Lance exactement cette commande avec l'outil Bash, sans rien faire d'autre, puis réponds en une ligne :
\`$DIR/dungeon \$ARGUMENTS\`
EOF
echo "✅ Slash command /dungeon ajouté"

echo
echo "👉 Redémarre Claude Code (les hooks sont lus au démarrage), puis : dungeon"
