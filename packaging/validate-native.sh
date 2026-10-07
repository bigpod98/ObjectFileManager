#!/usr/bin/env bash
set -euo pipefail
format=$1
useradd -m tester
# Optional real-package upgrade test, using downloaded 1.0.2 release artifacts.
if [[ -d /legacy ]]; then
  case "$format" in
    deb) apt-get update; apt-get install -y --no-install-recommends /legacy/*.deb ;;
    rpm) dnf install -y /legacy/*.rpm ;;
    alpm) pacman -Syu --noconfirm; pacman -U --noconfirm /legacy/*.pkg.tar.zst ;;
  esac
  S3_PACKAGE_VERSION=1.0.2 S3_SMOKE_EXECUTABLE=/usr/bin/s3-browser S3_SMOKE_TITLE='S3 Browser' python3 /recipes/smoke.py
fi
case "$format" in
  deb)
    apt-get update
    apt-get install -y --no-install-recommends "/packages/objectfilemanager_${S3_PACKAGE_VERSION}-1_${S3_DEB_ARCH}.deb"
    dpkg-query -W objectfilemanager
    # Debian images exclude most documentation but keep copyright files.
    grep -q '^License: MIT$' /usr/share/doc/objectfilemanager/copyright
    dpkg --compare-versions "$S3_PACKAGE_VERSION-1" lt "$S3_PACKAGE_VERSION-2"
    ;;
  rpm)
    dnf install -y "/packages/objectfilemanager-${S3_PACKAGE_VERSION}-1.${S3_NATIVE_ARCH}.rpm"
    rpm -V objectfilemanager
    test "$(rpm -q --queryformat '%{LICENSE}' objectfilemanager)" = MIT
    test "$(rpm --eval '%{lua:print(rpm.vercmp("0.1.0-1", "0.1.0-2"))}')" = '-1'
    ;;
  alpm)
    # The minimal Arch image excludes documentation; validate the full installed package.
    sed -i '/^NoExtract[[:space:]]*=/d' /etc/pacman.conf
    pacman -Syu --noconfirm
    if [[ -d /legacy ]]; then
      # Explicitly accept replacing the conflicting old package, then installation.
      printf 'y\ny\n' | pacman -U "/packages/objectfilemanager-${S3_PACKAGE_VERSION}-1-${S3_NATIVE_ARCH}.pkg.tar.zst"
    else
      pacman -U --noconfirm "/packages/objectfilemanager-${S3_PACKAGE_VERSION}-1-${S3_NATIVE_ARCH}.pkg.tar.zst"
    fi
    pacman -Qkk objectfilemanager
    pacman -Qi objectfilemanager | grep -Eq '^Licenses +: MIT$'
    test "$(vercmp "$S3_PACKAGE_VERSION-1" "$S3_PACKAGE_VERSION-2")" = '-1'
    ;;
esac
if [[ -d /legacy ]]; then
  test ! -e /usr/bin/s3-browser
  test ! -e /opt/s3-browser
  test -s /tmp/s3browser-package-profile/keep-me.txt
  test -s /tmp/s3browser-package-profile/transfers.sqlite
fi
test "$(readlink /usr/bin/objectfilemanager)" = '/opt/objectfilemanager/objectfilemanager'
test "$(stat -c '%u:%g:%a' /opt/objectfilemanager/chrome-sandbox)" = '0:0:4755'
test -s /usr/share/icons/hicolor/512x512/apps/com.tuxbase.s3browser.png
desktop-file-validate /usr/share/applications/com.tuxbase.s3browser.desktop
for license in LICENSE THIRD_PARTY_NOTICES.txt LICENSE.electron.txt LICENSES.chromium.html; do
  test -s "/usr/share/licenses/objectfilemanager/$license"
  cmp "/usr/share/licenses/objectfilemanager/$license" "/opt/objectfilemanager/$license"
done
if ldd /opt/objectfilemanager/objectfilemanager | grep -q 'not found'; then
  ldd /opt/objectfilemanager/objectfilemanager
  exit 1
fi
python3 /recipes/smoke.py
case "$format" in
  deb) apt-get purge -y objectfilemanager ;;
  rpm) dnf remove -y objectfilemanager ;;
  alpm) pacman -R --noconfirm objectfilemanager ;;
esac
test ! -e /usr/bin/objectfilemanager
test ! -e /opt/objectfilemanager
test ! -e /usr/share/applications/com.tuxbase.s3browser.desktop
test -s /tmp/s3browser-package-profile/keep-me.txt
test -s /tmp/s3browser-package-profile/transfers.sqlite
printf 'PASS: %s installation, desktop startup, package removal, and retained user data.\n' "$format"
