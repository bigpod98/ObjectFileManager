#!/usr/bin/env bash
set -euo pipefail
format=$1
case "$format" in
  deb)
    apt-get update
    apt-get install -y --no-install-recommends "/packages/s3-browser_${S3_PACKAGE_VERSION}-1_${S3_DEB_ARCH}.deb"
    dpkg-query -W s3-browser
    dpkg --compare-versions "$S3_PACKAGE_VERSION-1" lt "$S3_PACKAGE_VERSION-2"
    ;;
  rpm)
    dnf install -y "/packages/s3-browser-${S3_PACKAGE_VERSION}-1.${S3_NATIVE_ARCH}.rpm"
    rpm -V s3-browser
    test "$(rpm --eval '%{lua:print(rpm.vercmp("0.1.0-1", "0.1.0-2"))}')" = '-1'
    ;;
  alpm)
    # The minimal Arch image excludes documentation; validate the full installed package.
    sed -i '/^NoExtract[[:space:]]*=/d' /etc/pacman.conf
    pacman -Syu --noconfirm
    pacman -U --noconfirm "/packages/s3-browser-${S3_PACKAGE_VERSION}-1-${S3_NATIVE_ARCH}.pkg.tar.zst"
    pacman -Qkk s3-browser
    test "$(vercmp "$S3_PACKAGE_VERSION-1" "$S3_PACKAGE_VERSION-2")" = '-1'
    ;;
esac
useradd -m tester
test "$(readlink /usr/bin/s3-browser)" = '/opt/s3-browser/s3-browser'
test "$(stat -c '%u:%g:%a' /opt/s3-browser/chrome-sandbox)" = '0:0:4755'
test -s /usr/share/icons/hicolor/512x512/apps/com.tuxbase.s3browser.png
desktop-file-validate /usr/share/applications/com.tuxbase.s3browser.desktop
if ldd /opt/s3-browser/s3-browser | grep -q 'not found'; then
  ldd /opt/s3-browser/s3-browser
  exit 1
fi
python3 /recipes/smoke.py
case "$format" in
  deb) apt-get purge -y s3-browser ;;
  rpm) dnf remove -y s3-browser ;;
  alpm) pacman -R --noconfirm s3-browser ;;
esac
test ! -e /usr/bin/s3-browser
test ! -e /opt/s3-browser
test ! -e /usr/share/applications/com.tuxbase.s3browser.desktop
test -s /tmp/s3browser-package-profile/keep-me.txt
test -s /tmp/s3browser-package-profile/transfers.sqlite
printf 'PASS: %s installation, desktop startup, package removal, and retained user data.\n' "$format"
