# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately by email to Primož Ajdišek (bigpod) at <bigpod@bigpod.si>, not in public issues or pull requests. Include:

- the affected version or commit, and your operating system and storage provider;
- steps to reproduce and the impact you observed;
- any suggested fix or mitigation.

Remove real credentials, access tokens, signed URLs, and private endpoint names from reports. A disposable local service such as MinIO or Azurite is the best way to demonstrate an issue.

This is a volunteer-maintained project. Reports are handled on a best-effort basis; there are no guaranteed response or fix times. Please allow reasonable time for a fix before public disclosure.

## Supported versions

Fixes are made on `main` and included in the next release. Older releases are not patched separately.

## Scope

In scope: the S3 Browser application, its handling of credentials and local state, its native and portable Linux packages, and this repository's build and release scripts.

Report vulnerabilities in Electron, Chromium, or a dependency to the respective upstream project. Tell us as well if S3 Browser is affected in a way that needs an update or workaround here. Server-side behavior of storage providers is out of scope, including servers that ignore conditional request headers (see the README's provider section).
