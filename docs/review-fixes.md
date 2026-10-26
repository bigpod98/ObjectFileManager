# Independent review remediation

Implemented against the supplied findings, starting from `4e7473b`, on
2026-10-26. Implementation was split among subagents and followed by independent
reviews of recovery and runtime behavior.
This records observed checks and limits, not a security certification.

## P1 fixes

- **Azure container escape:** all blob access paths validate keys before SDK URL
  construction; copy also validates its decoded source and destination. Exact
  dot path segments fail before requests. Real-SDK loopback tests prove zero
  requests for unsafe names and correct nested-name routing.
- **Interrupted GCS replacements:** queue rows retain the original
  generation/metageneration or proven absence before writes. Automatic/manual
  retries, pause and restart keep that condition. Completed uploads require the
  operation token, intended SHA-256, size, and verified remote bytes. A corrupt
  owned commit followed by a lost reply/412 remains a failure with its recovery
  evidence intact; a foreign create-only winner can remain a skip.
- **Download temporary names:** every path component rejects the reserved
  `.objectfilemanager-` prefix without regard to case. Regressions cover exact
  generated temporary and publication-marker aliases while preserving existing
  bytes.

## P2 fixes

- **S3 timeouts:** enforce connection, inactivity, and request limits independently;
  real SDK loopback tests cover stalls, retries, trickled headers, healthy long
  or throttled transfers, and cancellation. See [timeout policy](s3-timeouts.md).
- **Sync deletion preflight:** repeat local validation after all remote HEAD
  checks and immediately before deletion; local preflight changes yield zero
  deletions. Retain per-object conditional deletes.
- **Symlinked selected-root ancestors:** persist a canonical root and directory
  identity for new upload, download, and sync manifests. Alias retargeting cannot
  redirect queued work; descendant symlinks and root substitution fail closed.
- **Swift IPv6:** use URL-aware request options. IPv6, IPv4 and DNS requests are
  tested; Keystone's existing URL-aware authentication also passes IPv6 coverage.
- **Malformed browse/search pages:** require valid nonrepeating continuation
  tokens for truncated pages and string keys within the requested prefix.
  Skip only the exact current folder marker.
- **Queue polling:** transactionally maintain summary counts with SQLite
  triggers. Routine polling reads jobs and summaries. Poll every 1.2 seconds in
  the visible queue, 5 seconds in the browser, and 15 seconds while hidden;
  refresh promptly on visibility changes, without overlapping polls.
- **Startup/worker/shutdown errors:** preserve damaged database bytes, report
  useful startup failures, retain and export failures when error recording fails,
  settle worker promises, release activity, and attempt every cleanup operation.
  Explicit runtime retries preserve completed work and integrity evidence, also
  across restart. Interrupted scans still require a new batch. Stale cleanup
  state cannot conceal a recorded runtime failure.
- **GCS signing:** conservatively expose unresolved credentials, then resolve
  signer support for the selected connection. User ADC without a signer cannot
  generate links; service accounts and supported remote/impersonated signers can.
  Probe reads do not block state mutations or other connections. Navigating to a
  bucket in the same connection does not discard a successful capability result.
- **Durable connection state:** flush temporary data before rename and the
  directory afterward where supported; preserve corrupt/recovery copies. Tests
  cover ordering, failures, permissions, exclusive creation and recovery. A
  post-rename directory-sync failure warns while keeping memory aligned with the
  installed file. Fault injection does not prove physical power-loss durability.

## P3 fixes

- **Moves with confirmed absent sources:** after verified copy, normalize only
  object-specific missing outcomes in the final source check/conditional delete.
  Bucket/endpoint errors, permission failures, ambiguous 404s and 412 remain
  failures. Never retry deletion unconditionally.
- **Completed cancellation:** reject completed-batch cancellation. Queued/running
  cancellation and active sync-cleanup cancellation retain their behavior.
- **Search case folding:** main and renderer share locale-independent lowercase
  comparison, including Turkish I/ı/İ and Unicode regressions.
- **GCS version bounds:** use the documented inclusive/exclusive name interval
  `[key, key + NUL)` on every page and return exact-name versions. Tests include
  Unicode, prefix siblings, all versions, and empty continuation pages. See the
  [GCS list API](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list).
- **Uploaded/skipped counts:** recognize prior commits only through operation
  identity and verified bytes; lost-reply/412 verification records `done`, while
  unrelated existing objects remain skips or conflicts.
- **Object Lock investigation:** validate disposable MinIO behavior and explicitly
  carry protection fields in both copy paths. Do not strip expired retention or
  legal holds. See [copy policy and service evidence](object-lock-copy-policy.md).
- **Security reporting:** restore [SECURITY.md](../SECURITY.md) using the private
  reporting route already established in CONTRIBUTING.md and repository history.
  Repository/issue links were checked; email deliverability was not tested.
- **Build/CI pins:** verify upstream Action commit SHAs and image-index digests;
  lock Azurite's existing test-only dependency tree. Document deliberate updates
  and the limits of reproducibility in [dependency updates](dependency-updates.md).

## Product decisions retained

- New downloaded files keep restrictive `0600` creation permissions, further
  restricted by the process umask. No permission option was added.
- Keystone retains its project-ID workaround for cross-domain projects; separate
  project-domain form fields were not introduced. See [instructions](keystone-project-id.md).
- Unproven sync equality still uploads conservatively. Added native full-object
  CRC32/CRC32C comparisons alongside SHA-256/SHA-1/MD5. Composite/untyped checksums
  and user metadata alone do not establish equality. The review displays an
  uncertainty count. A synthetic 13-case matrix at both 1 KiB and 8 MiB + 1 byte
  gives 6 unchanged and 7 uncertain cases at each size. This measures checksum
  coverage, not real provider prevalence. CRC64NVME remains unsupported.
- Unsafe download selections fail as a whole. No silent skip mode or omissions
  manifest was introduced.

## Validation and practical limits

The final full test suite passed **442 tests, zero failures and zero skips**
against fresh disposable MinIO and Azurite. Additional checks passed for provider
forms, **21 browser navigation checks**, formatting, native x86_64
DEB/RPM/Arch installation/startup/removal, and x86_64/ARM64 Electron bundle builds.
All 23 source assets in each bundle were compared byte-for-byte with the final
checkout; test-service dependencies are excluded from the application archives.

The million-row benchmark populated persisted summaries and verified counts
after restart. Across 500 polls, measured p50 was 0.070 ms, p95 0.124 ms, and
maximum 0.463 ms, with 500 event-loop turns. Population took 12.447 seconds under
concurrent build/test load. Existing databases need one initial summary backfill;
routine polls never aggregate the entry table. Run `npm run test:scale -- --queue-only`.

Live AWS/Azure/GCS accounts, ARM64 native package execution, and hosted Actions
were not tested. Object Lock large multipart completion uses simulated SDK
responses; live service tests cover small copies and multipart initiation.
Historical rows without a saved root identity cannot retroactively detect a
substitution before resume. Legacy GCS pending rows without a saved revision
require review unless their completed operation can be verified.

Portable Node filesystem APIs leave a narrow concurrent path-replacement race.
Local mutations after the final sync check cannot be atomic with remote deletes.
Keep selected trees unchanged throughout transfers and cleanup.

The audit performed during this work reports 3 affected entries in the existing
application dependency tree (Electron, fast-uri and undici) and 14 in the pinned
test-only Azurite tree. Pins improve repeatability; they do not resolve these
separate version advisories or certify exploitability. No application dependency
upgrade, new dependency, release publication, or deployment was performed.
