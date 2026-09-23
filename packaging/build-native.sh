#!/usr/bin/env bash
set -euo pipefail
format=$1
mkdir -p /build /output
case "$format" in
  deb)
    cp -a /input/payload /build/deb
    mkdir -p /build/deb/DEBIAN
    cp /input/control /build/deb/DEBIAN/control
    desktop-file-validate /build/deb/usr/share/applications/com.tuxbase.s3browser.desktop
    dpkg-deb --root-owner-group -Zxz -z3 --build /build/deb /output/
    for package in /output/*.deb; do dpkg-deb --info "$package"; done
    ;;
  rpm)
    mkdir -p /build/rpm/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
    rpmbuild -bb --define '_topdir /build/rpm' /input/s3-browser.spec
    cp /build/rpm/RPMS/x86_64/*.rpm /output/
    rpm -qip /output/*.rpm
    ;;
  alpm)
    useradd -m builder
    cp /input/PKGBUILD /input/payload.tar.gz /build/
    chown -R builder:builder /build
    cd /build
    # Dependencies belong to the installation test; this recipe repacks an already built app.
    runuser -u builder -- env PACKAGER="Primož Ajdišek <bigpod@bigpod.si>" makepkg --nodeps --noconfirm
    cp /build/*.pkg.tar.zst /output/
    pacman -Qip /output/*.pkg.tar.zst
    ;;
  *) exit 2 ;;
esac
