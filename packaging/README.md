# Native Linux packages

ObjectFileManager (OFM) replaces S3 Browser beginning with version 1.0.3. The
package and command are `objectfilemanager`. DEB, RPM, and Arch metadata declare
replacement of the old package. The desktop ID `com.tuxbase.s3browser`, Electron
storage/keyring identity `s3-browser`, and existing profile directory stay stable
so upgrades retain desktop integration, saved connections, and transfer history.
Remote metadata fields and resumable download filenames also retain their old
identifiers for compatibility. Repository links still point to `bigpod98/S3Browser`.

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

Arch Linux ARM uses the [upstream AArch64 root filesystem](https://archlinuxarm.org/platforms/armv8/generic) and its signed package repositories. The root filesystem supplies the pacman keyring that later package checks rely on, so `alpm/verify-signature.sh` checks the upstream detached signature before extraction. It accepts only the vendored `alpm/archlinuxarm-builder.asc` key with primary fingerprint `68B3537F39A313B3E574D06777193F152BDBE6A6`, the Arch Linux ARM Build System key [published by the project](https://archlinuxarm.org/about/package-signing). A modified tarball or a signature from another key stops the image build. The `latest` tarball is still a moving input: verification proves that upstream signed it, but not which release a mirror serves, so an older signed tarball would also be accepted before `pacman -Syu` upgrades it. A revoked or rotated upstream key requires updating the vendored key and pinned fingerprint. Both Arch variants are rolling distributions; `.BUILDINFO` records each package's build environment.

Package versions use the application version plus package release `1`, for example `0.1.0-1`. Stable `major.minor.patch` versions are required. Prerelease/daily version conversion is deliberately not implemented. Native version comparison checks confirm that increasing the package release upgrades the preceding release.

## Installed files

- `/opt/objectfilemanager/`: private application and Electron runtime.
- `/usr/bin/objectfilemanager`: symlink to the executable.
- `/usr/share/applications/com.tuxbase.s3browser.desktop`: application menu entry.
- `/usr/share/icons/hicolor/512x512/apps/com.tuxbase.s3browser.png`: application icon.
- `/usr/share/doc/objectfilemanager/`: README and the Debian-format `copyright` file.
- `/usr/share/licenses/objectfilemanager/`: `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `LICENSE.electron.txt`, and `LICENSES.chromium.html`, also present in `/opt/objectfilemanager/`.

Files are root-owned. The Chromium sandbox helper is root-owned mode `4755`, as required for its setuid fallback. The installed launcher does not disable sandboxing. The app uses the desktop OS keyring if available; `gnome-keyring` is recommended/optional, rather than required for session-only connections.

ObjectFileManager is MIT-licensed. RPM and ALPM metadata declare `MIT` for the project; Debian's `copyright` file declares MIT for the project and points to the bundled-component notices. Packages are unsigned. The release workflow attaches them to the tagged GitHub release; native package registry publication is not configured. The maintainer is Primož Ajdišek <bigpod@bigpod.si>.

## License notices

Every build carries the same four license files beside the executable. Native packages install them in `/usr/share/licenses/objectfilemanager/`, and portable archives contain them at the top level:

- `LICENSE`: ObjectFileManager's MIT license.
- `THIRD_PARTY_NOTICES.txt`: the license and notice files of every npm production dependency in `resources/app.asar`.
- `LICENSE.electron.txt` and `LICENSES.chromium.html`: the Electron runtime, Chromium, Node.js and their components, as shipped by Electron.

The project license does not relicense bundled components. `scripts/third-party-notices.cjs` runs as electron-builder's `afterPack` hook. It takes production packages from `package-lock.json` and requires each installed version to match. It copies their `LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, and `COPYRIGHT` files verbatim, in a deterministic order. The hook fails if `app.asar` contains a package version missing from the notices. `npm run dist:packages` regenerates the notices and refuses a bundle whose copy is missing or stale.

A few packages publish no license file. For these, the generator accepts a README license section only when it contains both a copyright notice and the license grant. Otherwise it uses a reviewed upstream text recorded for that exact package version in `licenses/upstream.json`, with its source commit, provenance, and SHA-256. Any other package without a license file stops the build. After dependency changes, review the new package's upstream license and add an entry rather than substituting a generic template. The tests also fail on entries that no longer match a bundled package version. Run `node scripts/third-party-notices.cjs` to print the current notices.

Runtime dependencies are declared in each native recipe. In particular, GTK, NSS, ALSA, X11, GBM, and secret-storage libraries are system dependencies; application code and the Electron runtime remain bundled. The recipes retain the prebuilt Electron binary without stripping or generating duplicate debug packages.

## Validation

```sh
npm run test:packages          # All formats
npm run test:packages -- deb   # One format
```

To exercise the rename upgrade, download the matching-architecture 1.0.2 release
packages into `deb/`, `rpm/`, and `alpm/` subdirectories of a temporary directory,
verify them against that release's `SHA256SUMS`, then run
`S3_TEST_UPGRADE_DIR=/path/to/old-packages npm run test:packages -- --x64`
(or `--arm64`). The test installs and launches the old package first, replaces it
with ObjectFileManager, checks that the old executable is removed and profile
files survive, then runs the normal startup and removal checks.

This installs the generated package using the distro package manager in a disposable container, letting it resolve the declared dependencies. It checks native metadata, version ordering, launcher/icon paths, executable library resolution, sandbox permissions, and desktop-file validity. It then starts the installed app as an unprivileged user under Xvfb and queries its real renderer through Chrome DevTools to verify the welcome screen, application version, SQLite initialization, and IPC calls.

After startup, the test removes the package and verifies that its executable and desktop entry are gone while the test user's transfer database and sentinel file remain. The application's own upload integration tests are separate (`npm test` and `npm run test:scale`).

The container smoke test uses `--no-sandbox` because Docker restricts nested Chromium sandbox namespaces. When testing a foreign architecture under QEMU, it also uses `--no-zygote` and `--in-process-gpu` to avoid emulated GPU/zygote subprocess failures, with a longer startup timeout. The ARM Arch builder disables pacman's download sandbox because QEMU does not provide Landlock; package signature checks remain enabled. This flag is confined to the test script; host desktop sandbox behavior and keyring integration need a real desktop session. Debian/Ubuntu compatibility beyond Debian 12 and RPM distributions beyond Fedora 43 are not exercised by these containers.

## GitHub Actions and releases

The workflows in `.github/workflows/` use GitHub-hosted Ubuntu runners with a `node:22-bookworm` job container for checks and builds. Each build job compiles MinIO from a pinned upstream commit with Go 1.25.5, installs Azurite 3.35.0, and starts fresh loopback test services through `scripts/ci/with-test-services.sh`. No cloud-account credentials are required.

- **CI** runs on every branch push, pull request and manual dispatch with `contents: read`. It installs locked dependencies, checks formatting, runs the backend suite against MinIO and Azurite, runs the provider form smoke and both Electron suites under Xvfb, and builds x86_64 and ARM64 Linux application bundles on `ubuntu-24.04`.
- **Release builds** run on pushed `vMAJOR.MINOR.PATCH` tags or a manual dispatch specifying an existing stable tag. They require the tag, checked-out commit and both package versions to agree; tag pushes also verify the event commit. Publication remains bound to the commit checked out by the build jobs. Prerelease tags are rejected. Separate `ubuntu-24.04` and `ubuntu-24.04-arm` jobs run the checks, build each architecture's portable archive and DEB/RPM/Arch packages, validate native installation/startup/removal, and smoke-test the bundled application. ARM64 packages run natively on the ARM runner. Docker Buildx builds the distro containers; package inputs are passed through `docker cp`.
- **Release publication** runs in a separate job only after both builds pass. It downloads the tested artifacts from the same workflow run, prepares the exact asset set and checksums, and uses `GITHUB_TOKEN` with `contents: write` to publish. Build jobs retain read-only permissions. No personal access token or `RELEASE_TOKEN` secret is required.

GitHub documents the [hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) and [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions). Hosted execution must still be verified after the repository is moved; local workflow validation does not execute GitHub's runners.

### Untrusted pull requests and runner isolation

CI uses `pull_request`, including fork contributions, with read-only permissions and no publication secrets. The contributed code runs dependency install scripts, tests, and packaging hooks. Keep these jobs on GitHub-hosted runners, where each standard Ubuntu job has its own VM, and require approval for outside contributors in the repository's Actions settings. Review workflow and script changes before approving runs. Do not switch to persistent self-hosted runners without separately reviewing their isolation.

Only the tag-triggered publication job requests write access. Tag reviewed commits, and restrict release tag creation using repository rules. See [GitHub migration](../docs/github-migration.md) for the repository setup and remaining migration steps.

The release assets are exactly:

```text
objectfilemanager_VERSION-1_amd64.deb
objectfilemanager-VERSION-1.x86_64.rpm
objectfilemanager-VERSION-1-x86_64.pkg.tar.zst
objectfilemanager-VERSION-linux-x64.tar.gz
objectfilemanager_VERSION-1_arm64.deb
objectfilemanager-VERSION-1.aarch64.rpm
objectfilemanager-VERSION-1-aarch64.pkg.tar.zst
objectfilemanager-VERSION-linux-arm64.tar.gz
SHA256SUMS
```

The publication script targets GitHub.com and derives the repository from `GITHUB_REPOSITORY` rather than a hard-coded owner. It verifies the remote tag still identifies the tested commit. New releases stay drafts until all nine assets are uploaded and downloaded again to verify their checksums. If the release already exists, its title and notes are retained, matching assets are reused, and only missing assets are added. Differing existing assets stop publication; the workflow never replaces release files or moves tags. Failed uploads can be retried, but a rebuild that produces different bytes requires resolving that conflict explicitly or releasing a new version.

The workflow passes the automatic `GITHUB_TOKEN` only to the publication step. These assets go on the repository's tagged GitHub release, not to a native package registry.

To release, update both version files, commit and push the changes, then push an annotated tag at that commit:

```sh
npm version 0.1.2 --no-git-tag-version
# Commit and push the versioned source before tagging it.
git tag -a v0.1.2 -m "Release 0.1.2"
git push origin v0.1.2
```

To retry a release after a workflow-only fix without moving its tag, run `gh workflow run release.yml --repo bigpod98/S3Browser --ref main -f tag=vMAJOR.MINOR.PATCH`. This uses the workflow from `main` while building and testing source from the existing tag.

Use the actual next version, and configure `origin` for `https://github.com/bigpod98/S3Browser.git` before pushing. There is no workflow that also publishes on release events, avoiding duplicate uploads. Windows/macOS installers and architectures other than Linux x86_64 and ARM64 are outside this workflow.
