# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to Primož Ajdišek (bigpod) at
<bigpod@bigpod.si>, the reporting address established in
[CONTRIBUTING.md](CONTRIBUTING.md). Do not use public issues or pull requests.
Include the affected version or commit, operating system, storage provider,
reproduction steps, and observed impact. Remove real credentials, access tokens,
signed URLs, and private endpoint names. Prefer disposable local services for
reproductions.

Reports are handled on a best-effort basis, without guaranteed response or fix
times. Allow reasonable time for a fix before public disclosure.

## Supported versions

Fixes are made on `main` and included in the next release. Older releases are not
patched separately.

## Scope

ObjectFileManager, its credential and local-state handling, native and portable
packages, and this repository's build and release scripts are in scope. Report
dependency vulnerabilities to their upstream maintainers and tell us when
ObjectFileManager needs an update. Storage-server behavior, including servers
that ignore conditional requests, is outside this application's control.
