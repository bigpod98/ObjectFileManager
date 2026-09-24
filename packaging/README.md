# Native Linux packages

Build all three formats from this project's source:

```sh
npm ci
npm run dist
```

`npm run dist:packages` is an alias. Docker must be available. The shared Electron build runs once, then native distro tooling packages its complete runtime and assets. Node.js is not required on the user's desktop. Install-time scripts do not download application files.

To build a single format, run `npm run dist:packages -- deb`, `rpm`, or `alpm`. For packaging-only iteration against an existing `dist/linux-unpacked` build, use `npm run dist:packages -- --skip-bundle`.

| Format | Native builder | Build container             | Architectures       | Output                           |
| ------ | -------------- | --------------------------- | ------------------- | -------------------------------- |
| DEB    | `dpkg-deb`     | Debian 12 (bookworm)        | `amd64`, `arm64`    | `dist/native/deb/*.deb`          |
| RPM    | `rpmbuild`     | Fedora 43                   | `x86_64`, `aarch64` | `dist/native/rpm/*.rpm`          |
| ALPM   | `makepkg`      | Arch Linux / Arch Linux ARM | `x86_64`, `aarch64` | `dist/native/alpm/*.pkg.tar.zst` |

Recipes support Linux x86_64 and ARM64. The default is the host architecture; select another with `--x64` or `--arm64`:

```sh
npm run dist:packages -- --arm64
npm run test:packages -- --arm64
npm run dist:portable -- --x64 --arm64 --publish never
```

Cross-architecture package containers require QEMU/binfmt support on the Docker host. The release workflow configures this automatically. ARM64 uses `dist/linux-arm64-unpacked`; x86_64 uses `dist/linux-unpacked`. Node/Electron's `x64` maps to Debian `amd64` and RPM/ALPM `x86_64`; `arm64` maps to Debian `arm64` and RPM/ALPM `aarch64`. Unknown architectures are rejected.

Arch Linux ARM uses the [upstream AArch64 root filesystem](https://archlinuxarm.org/platforms/armv8/generic), fetched over HTTPS from an upstream mirror, and its signed package repositories. Both Arch variants are rolling distributions; `.BUILDINFO` records each package's build environment.

Package versions use the application version plus package release `1`, for example `0.1.0-1`. Stable `major.minor.patch` versions are required. Prerelease/daily version conversion is deliberately not implemented. Native version comparison checks confirm that increasing the package release upgrades the preceding release.

## Installed files

- `/opt/s3-browser/`: private application and Electron runtime.
- `/usr/bin/s3-browser`: symlink to the executable.
- `/usr/share/applications/com.tuxbase.s3browser.desktop`: application menu entry.
- `/usr/share/icons/hicolor/512x512/apps/com.tuxbase.s3browser.png`: application icon.
- `/usr/share/doc/s3-browser/`: documentation and license notice.
- `/usr/share/licenses/s3-browser/`: bundled Electron/Chromium notices.

Files are root-owned. The Chromium sandbox helper is root-owned mode `4755`, as required for its setuid fallback. The installed launcher does not disable sandboxing. The app uses the desktop OS keyring if available; `gnome-keyring` is recommended/optional, rather than required for session-only connections.

The application has no selected redistribution license, so the RPM and ALPM metadata use `LicenseRef-Unknown`. Packages are unsigned. The release workflow attaches them to the tagged Forgejo release; native package registry publication is not configured. Maintainer metadata follows the user's existing `usageSoftware` Debian package.

Runtime dependencies are declared in each native recipe. In particular, GTK, NSS, ALSA, X11, GBM, and secret-storage libraries are system dependencies; application code and the Electron runtime remain bundled. The recipes retain the prebuilt Electron binary without stripping or generating duplicate debug packages.

## Validation

```sh
npm run test:packages          # All formats
npm run test:packages -- deb   # One format
```

This installs the generated package using the distro package manager in a disposable container, letting it resolve the declared dependencies. It checks native metadata, version ordering, launcher/icon paths, executable library resolution, sandbox permissions, and desktop-file validity. It then starts the installed app as an unprivileged user under Xvfb and queries its real renderer through Chrome DevTools to verify the welcome screen, application version, SQLite initialization, and IPC calls.

After startup, the test removes the package and verifies that its executable and desktop entry are gone while the test user's transfer database and sentinel file remain. The application's own upload integration tests are separate (`npm test` and `npm run test:scale`).

The container smoke test uses `--no-sandbox` because Docker restricts nested Chromium sandbox namespaces. When testing a foreign architecture under QEMU, it also uses `--no-zygote` and `--in-process-gpu` to avoid emulated GPU/zygote subprocess failures, with a longer startup timeout. The ARM Arch builder disables pacman's download sandbox because QEMU does not provide Landlock; package signature checks remain enabled. This flag is confined to the test script; host desktop sandbox behavior and keyring integration need a real desktop session. Debian/Ubuntu compatibility beyond Debian 12 and RPM distributions beyond Fedora 43 are not exercised by these containers.

## Forgejo CI and releases

The workflows in `.forgejo/workflows/` follow this account's `docker` runner convention. They target an x86_64 Docker host and use a `node:22-bookworm` job container and a disposable MinIO service, with no external storage credentials. The runner must support Forgejo service `cmd` and allow the release job to access a Docker daemon with privileged QEMU/binfmt setup. Package containers receive their inputs through `docker cp`, so the job workspace does not need to exist at the same path on the daemon host. Workflow syntax follows the [Forgejo Actions reference](https://forgejo.org/docs/latest/user/actions/reference/).

- **CI** runs on every branch push, pull request and manual dispatch. It installs locked dependencies, checks formatting, runs the backend suite against MinIO, runs both Electron suites under Xvfb, and builds x86_64 and ARM64 Linux application bundles.
- **Release** runs only on a pushed `vMAJOR.MINOR.PATCH` tag. It requires the tag, checked-out commit, event commit, `package.json` and `package-lock.json` to agree. Prerelease tags are rejected because native package version conversion is not implemented. It repeats the checks, builds portable archives for both architectures, builds DEB/RPM/Arch from each corresponding unpacked runtime, validates installation/startup/removal for each native package, and smoke-tests the bundled application.

The release assets are exactly:

```text
s3-browser_VERSION-1_amd64.deb
s3-browser-VERSION-1.x86_64.rpm
s3-browser-VERSION-1-x86_64.pkg.tar.zst
s3-browser-VERSION-linux-x64.tar.gz
s3-browser_VERSION-1_arm64.deb
s3-browser-VERSION-1.aarch64.rpm
s3-browser-VERSION-1-aarch64.pkg.tar.zst
s3-browser-VERSION-linux-arm64.tar.gz
SHA256SUMS
```

The publication script derives the instance and repository from the workflow context rather than a hard-coded owner. It verifies the remote tag still identifies the tested commit. New releases stay drafts until all nine assets are uploaded and downloaded again to verify their checksums. If the release already exists, its title and notes are retained, matching assets are reused, and only missing assets are added. Differing existing assets stop publication; the workflow never replaces release files or moves tags. Failed uploads can be retried, but a rebuild that produces different bytes requires resolving that conflict explicitly or releasing a new version.

The normal workflow token is used for repository release access. If the instance restricts that token, configure the repository Actions secret `RELEASE_TOKEN` with `write:repository` access to this repository. No publication token is passed to the checks or package builders. These assets go on the repository's tagged release, not to a native package registry.

To release, update both version files, commit and push the changes, then push an annotated tag at that commit:

```sh
npm version 0.1.2 --no-git-tag-version
# Commit and push the versioned source before tagging it.
git tag -a v0.1.2 -m "Release 0.1.2"
git push origin v0.1.2
```

Use the actual next version, and configure `origin` for the Forgejo repository before pushing. There is no workflow that also publishes on release events, avoiding duplicate uploads. Windows/macOS installers and architectures other than Linux x86_64 and ARM64 are outside this workflow.
