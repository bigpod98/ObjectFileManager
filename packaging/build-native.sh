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
    rpmbuild -bb --define '_topdir /build/rpm' /input/objectfilemanager.spec
    cp /build/rpm/RPMS/*/*.rpm /output/
    rpm -qip /output/*.rpm
    ;;
  alpm)
    useradd -m builder
    cp /input/PKGBUILD /input/payload.tar.gz /build/
    cp /etc/makepkg.conf /build/makepkg.conf
    # Arch Linux ARM defaults to xz; use the same release format on both arches.
    sed -i "s/^PKGEXT=.*/PKGEXT='.pkg.tar.zst'/" /build/makepkg.conf
    chown -R builder:builder /build
    cd /build
    # Dependencies belong to the installation test; this recipe repacks an already built app.
    runuser -u builder -- env PACKAGER="Primož Ajdišek <bigpod@bigpod.si>" makepkg --config /build/makepkg.conf --nodeps --noconfirm
    cp /build/*.pkg.tar.zst /output/
    pacman -Qip /output/*.pkg.tar.zst
    ;;
  *) exit 2 ;;
esac
