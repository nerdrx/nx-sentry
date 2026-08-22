#!/usr/bin/env bash
# Build, sign and publish a release.
#
#   scripts/release.sh [-n]      -n builds and signs but does not publish
#
# Assets carry two sidecars, matching the rest of the NX family:
#   <asset>.sha256  the digest NX Hub verifies every download against
#   <asset>.sig     ed25519 over that digest, from the per-owner NX release key
# The key lives OUTSIDE every repository and is never copied into one.
set -euo pipefail
cd "$(dirname "$0")/.."

KEY=${NX_SIGNING_KEY:-/run/media/nerdrx/Lex/claude/tools/nx-signing/nx-release.key}
DRY=0
[[ ${1:-} == "-n" ]] && DRY=1

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

echo "==> building $TAG"
npx --no-install electron-builder --linux --publish never

ASSETS=()
for f in dist/nx-sentry-"$VERSION"-linux-*.AppImage; do
    [[ -f $f ]] || continue
    sha256sum "$f" | awk '{print $1}' > "$f.sha256"
    if [[ -r $KEY ]]; then
        node -e 'const fs=require("fs"),c=require("crypto");
          const d=c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest();
          const k=c.createPrivateKey(fs.readFileSync(process.argv[2],"utf8"));
          process.stdout.write(c.sign(null,d,k).toString("hex")+"\n");' "$f" "$KEY" > "$f.sig"
        ASSETS+=("$f" "$f.sha256" "$f.sig")
    else
        # An unsigned release is still installable; it just will not verify for
        # anyone who has turned on "require signatures" in NX Hub.
        echo "!! signing key not readable at $KEY — publishing unsigned"
        ASSETS+=("$f" "$f.sha256")
    fi
done
[[ ${#ASSETS[@]} -gt 0 ]] || { echo "no assets built"; exit 1; }

printf '  %s\n' "${ASSETS[@]}"
[[ $DRY -eq 1 ]] && { echo "==> dry run, not publishing"; exit 0; }

echo "==> publishing $TAG"
gh release create "$TAG" "${ASSETS[@]}" --title "NX Sentry $VERSION" --notes-file "${NOTES:-/dev/stdin}"
