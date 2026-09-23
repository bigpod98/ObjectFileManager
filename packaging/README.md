# Native Linux packages

Build all three formats from this project's source:

```sh
npm ci
npm run dist
```

`npm run dist:packages` is an alias. Docker must be available. The shared Electron build runs once, then native distro tooling packages its complete runtime and assets. Node.js is not required on the user's desktop. Install-time scripts do not download application files.

To build a single format, run `npm run dist:packages -- deb`, `rpm`, or `alpm`. For packaging-only iteration against an existing `dist/linux-unpacked` build, use `npm run dist:packages -- --skip-bundle`.

| Format | Native builder | Build container      | Architecture | Output                           |
| ------ | -------------- | -------------------- | ------------ | -------------------------------- |
| DEB    | `dpkg-deb`     | Debian 12 (bookworm) | `amd64`      | `dist/native/deb/*.deb`          |
| RPM    | `rpmbuild`     | Fedora 43            | `x86_64`     | `dist/native/rpm/*.rpm`          |
| ALPM   | `makepkg`      | Arch Linux           | `x86_64`     | `dist/native/alpm/*.pkg.tar.zst` |

Only Linux x86_64 builds are supported by these recipes. Node/Electron's `x64` maps to Debian `amd64` and RPM/ALPM `x86_64`. Other architectures are rejected instead of being mislabeled. Arch uses a rolling build image; the resulting package records its build environment in `.BUILDINFO`.

Package versions use the application version plus package release `1`, for example `0.1.0-1`. Stable `major.minor.patch` versions are required. Prerelease/daily version conversion is deliberately not implemented. Native version comparison checks confirm that increasing the package release upgrades the preceding release.

## Installed files

- `/opt/s3-browser/`: private application and Electron runtime.
- `/usr/bin/s3-browser`: symlink to the executable.
- `/usr/share/applications/com.tuxbase.s3browser.desktop`: application menu entry.
- `/usr/share/icons/hicolor/512x512/apps/com.tuxbase.s3browser.png`: application icon.
- `/usr/share/doc/s3-browser/`: documentation and license notice.
- `/usr/share/licenses/s3-browser/`: bundled Electron/Chromium notices.

Files are root-owned. The Chromium sandbox helper is root-owned mode `4755`, as required for its setuid fallback. The installed launcher does not disable sandboxing. The app uses the desktop OS keyring if available; `gnome-keyring` is recommended/optional, rather than required for session-only connections.

The application has no selected redistribution license, so the RPM and ALPM metadata use `LicenseRef-Unknown`. These are local, unsigned packages; no repository publication is performed. Maintainer metadata follows the user's existing `usageSoftware` Debian package.

Runtime dependencies are declared in each native recipe. In particular, GTK, NSS, ALSA, X11, GBM, and secret-storage libraries are system dependencies; application code and the Electron runtime remain bundled. The recipes retain the prebuilt Electron binary without stripping or generating duplicate debug packages.

## Validation

```sh
npm run test:packages          # All formats
npm run test:packages -- deb   # One format
```

This installs the generated package using the distro package manager in a disposable container, letting it resolve the declared dependencies. It checks native metadata, version ordering, launcher/icon paths, executable library resolution, sandbox permissions, and desktop-file validity. It then starts the installed app as an unprivileged user under Xvfb and queries its real renderer through Chrome DevTools to verify the welcome screen, application version, SQLite initialization, and IPC calls.

After startup, the test removes the package and verifies that its executable and desktop entry are gone while the test user's transfer database and sentinel file remain. The application's own upload integration tests are separate (`npm test` and `npm run test:scale`).

The container smoke test uses `--no-sandbox` because Docker restricts nested Chromium sandbox namespaces. This flag is confined to the test script; host desktop sandbox behavior and keyring integration need a real desktop session. Debian/Ubuntu compatibility beyond Debian 12 and RPM distributions beyond Fedora 43 are not exercised by these containers.
