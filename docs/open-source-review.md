# Open-source readiness review

Historical review of the Forgejo version, before the later
[GitHub migration preparation](github-migration.md). The workflow descriptions
and hosted-runner caveats below refer to that reviewed version.

Reviewed on 2026-10-07, starting at `2b5caf212b272651bd1091244e36208756a4464d`.
The owner requested three independent reviews followed by fixes, and selected
the MIT license. Reviews ran through T3 delegated tasks with GPT-6.1 Sol
(high effort), GPT-6 Astra (medium), and Claude Opus 5.5 (high). Findings below
were checked against the implementation rather than accepted by vote.

This is a bounded engineering review, not a certification or an exhaustive
security audit. No real cloud credentials or production buckets were used.

## Consolidated findings

| Finding                                                                                                                    | Reviewers                                 | Verdict and priority                                                            | Resolution                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No application license; RPM/Arch and generated notices say licensing is unknown                                            | All three                                 | Confirmed, P1 publication blocker                                               | Added MIT license and metadata, native package licensing, and portable/native notices covering actual bundled dependencies. Build checks reject missing, stale, or uncovered notices.                                       |
| Ordinary upload scans omit source roots, allowing replaced parent symlinks to redirect reads                               | Sol, Astra                                | Confirmed, P2 data safety/privacy                                               | Fixed in `queue.cjs` and `storage.cjs`: persist roots, check every ancestor including legacy entries, and stream validated no-follow handles. Fourteen regressions cover the reproduced failure and restart/retry behavior. |
| Damaged connection files are overwritten on the next save; concurrent mutations share a temporary file and unsafe rollback | Opus; parent reproduced overlapping saves | Confirmed, P2 data preservation                                                 | Fixed with byte-preserving corrupt backups, fail-closed saves when backup fails, serialized mutations, commit-after-save state, and rollback recovery. Locked ciphertext is retained.                                       |
| ARM64 Arch bootstrap trusts an unchecked mutable root filesystem                                                           | Opus                                      | Confirmed supply-chain hardening gap, P2                                        | The ARM bootstrap now verifies the detached signature using a vendored key and pinned primary fingerprint before extraction. The real upstream tarball passed verification; the signed rootfs remains a rolling input.      |
| Provider form smoke and Azurite integration do not run in release gates                                                    | All three                                 | Confirmed coverage gap, P2                                                      | Both suites are required by the shared CI/release check script. The Azurite test supports isolated external endpoints as well as local Docker.                                                                              |
| Existing MinIO service image cannot be pulled anonymously                                                                  | Parent                                    | Confirmed reproducibility failure in this environment, P2                       | CI builds MinIO from an immutable upstream commit with a pinned Go toolchain. The shared helper starts fresh loopback MinIO/Azurite processes and cleans up after success or failure.                                       |
| Dependency audit reports 11 affected package entries                                                                       | All three                                 | Confirmed dependency maintenance issue, P2; no demonstrated application exploit | Updated `http-cache-semantics` within its compatible range; scoped overrides select CommonJS-compatible `uuid@11.1.1` for Gaxios and `global-agent@4.1.3` for Electron's downloader. Full audit now reports zero.           |
| Contributor/security instructions and repository/runtime metadata are missing                                              | All three                                 | Confirmed contributor-readiness gap, P3                                         | Added CONTRIBUTING.md, SECURITY.md, Forgejo repository/issue links, and the Node >=22.13.0 engine requirement.                                                                                                              |
| Packaging descriptions omit native providers and docs reference internal conversations                                     | Opus                                      | Confirmed documentation issue, P3                                               | Updated public-facing package descriptions and documentation for every supported provider and the new local test setup.                                                                                                     |
| Unused direct-download IPC bypasses queued download safeguards                                                             | Opus                                      | Confirmed redundant weaker path, P3; no renderer caller                         | Removed from main-process IPC, preload allowlist, and storage helpers. The renderer uses the guarded queued-download path.                                                                                                  |
| HTTPS Keystone authentication can yield a plaintext HTTP storage endpoint                                                  | Opus                                      | Confirmed transport downgrade, P2                                               | HTTPS-to-HTTP catalog downgrade is rejected before token transmission. Explicit HTTP deployments remain supported; regressions cover both.                                                                                  |
| Swift object-key dot segments can be interpreted differently by intermediaries                                             | Opus                                      | Defensive correctness fix, P2; no proxy exploit demonstrated                    | Exact dot segments are rejected for requests, copy paths, and links before storage requests. Ordinary dotted names and literal percent sequences remain supported.                                                          |
| Routine desktop tests overwrite tracked documentation screenshots                                                          | Sol, Opus                                 | Confirmed contributor/test hygiene issue, P3                                    | Screenshots now go to ignored `test-results/desktop`; `S3_TEST_REFRESH_ASSETS=1` explicitly regenerates documentation images.                                                                                               |
| Valid JSON with malformed saved-location lists breaks navigation                                                           | Opus                                      | Confirmed local robustness issue, P3                                            | Malformed location data is backed up and valid entries recovered. Connection deletion removes associated locations with rollback/recovery for persistence failures.                                                         |

## Findings that require qualification or an external decision

- **Runner trust:** Both existing workflows use the established `docker` label.
  The checkout does not establish whether fork jobs receive a Docker socket or
  share a persistent host with trusted release jobs. A socket grants extensive
  host control. Review runner configuration and Forgejo fork-workflow approval
  before accepting untrusted pull requests. No new, nonexistent runner labels
  are assumed by this change. Repository code cannot certify host isolation.
- **Provider conditions:** The client supplies conditional headers and refuses
  to retry without them. A storage server that silently ignores conditions can
  still violate the intended safety guarantees. This is a provider compatibility
  requirement, not proof that the client drops guards.
- **Filesystem races:** Rejecting symlink ancestors and checking opened files
  addresses the reproduced failure. Node's portable path APIs cannot guarantee
  that a malicious local process never swaps directory components between checks
  and file operations. Do not treat this app as a sandbox against an attacker
  with write access to its source/destination trees.
- **Electron fuses:** Additional packaging fuses are optional hardening. The
  application already enables renderer sandboxing/context isolation, disables
  Node integration, checks IPC senders, and blocks navigation/new windows. Fuse
  changes were not needed to fix a demonstrated defect and can affect desktop
  automation, so they are deferred.
- **Signing and platforms:** Native packages are unsigned; Windows/macOS and
  real cloud-account compatibility remain unverified. These limits were already
  disclosed and are not converted into claims of tested support.
- **Author metadata:** Public maintainer addresses already appear in repository
  history and packaging. History is not rewritten, and local branches/stashes
  are not published as part of this work.

## Rejected or narrowed claims

- `private: true` prevents accidental npm publication; it does not prevent this
  desktop application's source from being open source.
- Disposable test credentials are fixtures, not evidence of exposed production
  credentials. Pattern scans did not identify genuine credentials, but they do
  not prove that every possible secret format is absent.
- The UUID advisory concerns buffer-taking v3/v5/v6 APIs. The inspected Gaxios
  path uses v4. The dependency was updated without claiming an exploitable
  application path. The other audited chains were build dependencies.
- GCS disallows objects named exactly `.` or `..`; the suspected routing case
  for those exact names is not a supported-object defect.
- Overwrite modes, non-atomic remote operations, file-level resume, plaintext
  path/key history, and ETag limitations are documented behavior.
- Test-only `--no-sandbox` flags do not disable sandboxing in normal launches.
- Opus's baseline summary described all four skips as MinIO tests. One was the
  opt-in Azurite suite; the recorded test outputs distinguish them below.

## Validation

Baseline: 199 tests passed, four integration tests skipped; formatting and the
headless provider-form smoke passed. Parent additionally ran the Azurite suite
successfully, and the Electron startup smoke under an isolated Xvfb display.
A pattern scan examined 246 blobs reachable through local Git refs without
printing candidate secret values; no patterns matched. Opus separately reported
a broader history scan without identifying genuine credentials.

After dependency updates: GCS tests passed (15 tests), Electron downloader proxy
initialization passed, and `npm audit` reported zero vulnerabilities. The full
suite against MinIO built from upstream release
`RELEASE.2025-09-07T16-13-09Z` passed 214 tests with only Azurite skipped. That tag
identifies commit `07c3a429bfed433e49018cb0f78a52145d4bedeb`.

Final source validation used Node 22.13.1 and both disposable backends:
**261 tests passed, zero failed, zero skipped**. The provider-form smoke,
Electron source smoke, expanded Electron workflows, and rebuilt x86_64 packaged
application smoke passed. Formatting, lockfile consistency and dependency audit
checks passed; the audit reports zero vulnerabilities.

The scale test scanned 50,000 entries in 26.561 seconds, uploaded them in 57.319
seconds with zero failures, and verified all 50,000 remote objects. Both Linux
x86_64 and ARM64 portable archives were rebuilt and inspected for the application,
dependency, Electron and Chromium notices. The real upstream ARM64 rootfs
signature and bootstrap build passed; negative tests reject modified files,
wrong signing keys, swapped key files and missing signatures.

The rebuilt x86_64 DEB, RPM and Arch packages passed installation, license/content
checks, desktop startup, uninstallation and user-data retention checks.

Native ARM64 packages were not rebuilt or installed in this run. Windows/macOS,
real cloud accounts, a normal desktop's keyring/sandbox environment, and hosted
Forgejo workflow execution remain untested. All artifacts were built locally;
no commit, push, release publication or repository-visibility change was made.

## External evidence

- [MinIO's upstream source-only distribution instructions](https://github.com/minio/minio#source-only-distribution).
- [UUID advisory and patched versions](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq).
- [HTTP cache semantics advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
- [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
- [Google Cloud object naming rules](https://docs.cloud.google.com/storage/docs/objects).
