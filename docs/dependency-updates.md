# Updating build and CI dependencies

Changes to build inputs require a reviewed change and the checks below. Do not
replace pins with moving tags or regenerate lockfiles during CI installation.
The application dependency tree remains in the root `package-lock.json`;
Azurite's test-only tree has its own manifest and lockfile in
`scripts/ci/test-services/` and is never shipped with the application.
The initial action and registry pins were verified on 2026-10-26.

## GitHub Actions

The workflow comments identify the reviewed release for each full commit SHA.
The initial pins resolve the existing major versions from the source
repositories; their action metadata and checkout, installer, artifact-transfer,
and builder setup entry points were inspected for compatibility with the
workflow's inputs and permissions:

- [actions/checkout v4.4.0](https://github.com/actions/checkout/tree/11d5960a326750d5838078e36cf38b85af677262)
- [actions/setup-go v5.6.0](https://github.com/actions/setup-go/tree/40f1582b2485089dde7abd97c1529aa768e1baff)
- [actions/setup-node v4.4.0](https://github.com/actions/setup-node/tree/49933ea5288caeca8642d1e84afbd3f7d6820020)
- [docker/setup-buildx-action v3.12.0](https://github.com/docker/setup-buildx-action/tree/8d2750c68a42422c14e847fe6c8ac0403b4cbd6f)
- [actions/upload-artifact v4.6.2](https://github.com/actions/upload-artifact/tree/ea165f8d65b6e75b540449e92b4886f43607fa02)
- [actions/download-artifact v4.3.0](https://github.com/actions/download-artifact/tree/d3f86a106a0bac45b974a628896c90dbdf5c8093)

For an update, select a release in the original owner's repository, read its
release notes and source diff (including bundled `dist/` code and dependency
changes), then resolve the tag from that repository:

```sh
git ls-remote https://github.com/actions/checkout.git 'refs/tags/v4.4.0' 'refs/tags/v4.4.0^{}'
```

Use the peeled commit for annotated tags. Review the action's runtime, network
downloads, credential handling and required permissions. Update both workflow
SHA references and version comments together. The SHA must come from the
upstream repository, as described in GitHub's
[secure use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

## Container images and downloaded tooling

CI's Node image and every external `FROM` in the package Dockerfiles use the
upstream tag plus its immutable image-index digest. The release builder also
pins the BuildKit image used by `setup-buildx-action`, whose default would
otherwise pull a moving image. Index digests preserve native architecture
selection: Node, Debian, Fedora and BuildKit include Linux amd64 and arm64;
the Arch Linux image supplies amd64 only. ARM Arch retains its separately
signature-verified upstream root filesystem.

Initially verified image-index references:

- `node:22-bookworm@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384`
- `debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8`
- `fedora:43@sha256:a651ddf48ea28a06ed4e1e6519f51c9f47e7a5a138722ade87369b8fbb7e5b42`
- `archlinux:base@sha256:52dfbd5afb23a220d5ee92dafcb4c788d96c026ed04179890c23adef4c897fa0`
- `moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea`

Resolve updates from the publisher's Docker Hub repositories:

```sh
docker buildx imagetools inspect docker.io/library/node:22-bookworm
docker buildx imagetools inspect docker.io/library/debian:bookworm-slim
docker buildx imagetools inspect docker.io/library/fedora:43
docker buildx imagetools inspect docker.io/library/archlinux:base
docker buildx imagetools inspect docker.io/moby/buildkit:buildx-stable-1
```

Use the top-level `Digest`, then inspect that exact digest and confirm the
required platforms before changing files. The initial digests were obtained
directly from `registry-1.docker.io/v2/…/manifests/…`; each response's
`Docker-Content-Digest` was checked against the SHA-256 of the manifest bytes.
Do not copy a config digest, layer digest, or single-architecture child digest.
See Docker's [digest guidance](https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier).

Keep the publication job's exact `node-version` aligned with the Node image's
`NODE_VERSION` (initially 22.23.4). Buildx is pinned separately to
[v0.38.1](https://github.com/docker/buildx/releases/tag/v0.38.1); review its
release before updating `with.version`. MinIO's existing source revision and
Go 1.25.5 stay pinned in `install-test-services.sh` and the workflow setup steps.
An action SHA alone does not pin tool versions downloaded by that action.

Image pins do not freeze GitHub-hosted runner contents, distro repositories,
Docker's stable apt packages, or Arch Linux ARM's signed `latest` rootfs.
Package installation still consumes signed current distro packages. Builds
therefore do not promise byte-for-byte reproducibility. Review these inputs
when updating pins; making complete distro snapshots is a separate change.
Digest updates are also how image security fixes are adopted; a tag's new
contents do not change a pinned build automatically.

## Azurite

Only the already-used Azurite package is declared in the CI manifest, at exact
version 3.35.0. The committed npm lockfile records all transitive versions,
registry tarball URLs and integrity hashes. The installer copies both files to
the external service cache and runs `npm ci --ignore-scripts`, replacing stale
installs and rejecting inconsistent manifests. Its lifecycle scripts are not
needed to run the published Azurite JavaScript service.

For an intentional update, review the
[Azurite release](https://github.com/Azure/Azurite/releases) and npm package
metadata, edit the exact version in the CI manifest, then regenerate only its
lockfile:

```sh
npm install --prefix scripts/ci/test-services --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
npm audit --prefix scripts/ci/test-services
```

Review transitive additions/removals, versions, integrity changes and audit
findings. A transitive-only update is also deliberate: use
`npm update --prefix scripts/ci/test-services --package-lock-only --ignore-scripts`
and review the diff. Do not use unreviewed overrides or `npm audit fix --force`.
Adding another direct dependency still requires explicit user approval.

The initial Azurite 3.35.0 lockfile audit on 2026-10-26 reported 14 findings
(11 moderate, 3 high). This change records the existing tool's dependencies;
it does not resolve those advisories. An Azurite upgrade needs a separate
review and service integration run.

## Validation before accepting an update

```sh
node --test test/ci-pins.test.cjs test/ci-services.test.cjs test/docker-key.test.cjs test/alpm-rootfs-signature.test.cjs test/package-target.test.cjs test/release.test.cjs
bash scripts/ci/install-test-services.sh
bash scripts/ci/with-test-services.sh bash scripts/ci/check.sh
npm run pack -- --linux --x64 --arm64 --publish never
npm run dist:packages -- --x64 --skip-bundle
npm run test:packages -- --x64
npm run dist:packages -- --arm64 --skip-bundle
npm run test:packages -- --arm64
```

Use a separate `OBJECTFILEMANAGER_TEST_SERVICE_DIR` when another task is using
the local service cache. Package checks require a Docker daemon and network
access; ARM64 requires a native runner or configured binfmt/QEMU. Require the
repository's CI and both native release build jobs to pass before tagging an
updated release. Reviewing a pin change does not authorize publication or
deployment; the release workflow remains the sole artifact publication path.
