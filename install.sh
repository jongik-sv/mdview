#!/bin/sh
# mdview macOS installer — curl로 받으면 quarantine 속성이 붙지 않아
# 미공증(unnotarized) 앱이어도 Gatekeeper 차단·xattr 해제 없이 바로 실행된다.
#
#   curl -fsSL https://raw.githubusercontent.com/jongik-sv/mdview/main/install.sh | sh
set -eu

REPO="jongik-sv/mdview"
DEST="/Applications"

case "$(uname -m)" in
  arm64) ASSET="mdview_aarch64.app.tar.gz" ;;
  x86_64) ASSET="mdview_x64.app.tar.gz" ;;
  *) echo "지원하지 않는 아키텍처: $(uname -m)" >&2; exit 1 ;;
esac

URL="https://github.com/$REPO/releases/latest/download/$ASSET"
echo "다운로드: $URL"

# 실행 중인 앱 종료 후 교체 (없으면 무시)
osascript -e 'quit app "mdview"' 2>/dev/null || true
sleep 1
rm -rf "$DEST/mdview.app"
curl -fsSL "$URL" | tar xz -C "$DEST"

VER=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/mdview.app/Contents/Info.plist" 2>/dev/null || echo '?')
echo "설치 완료: $DEST/mdview.app (v$VER)"
echo "실행: open -a mdview"
