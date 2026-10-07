# S3 Browser

A local desktop browser for Amazon S3, Cloudflare R2, Ceph RGW, MinIO, custom S3-compatible endpoints, OpenStack Swift, Azure Blob Storage, and Google Cloud Storage. Browse and organize objects, queue uploads and folder downloads, inspect object versions and metadata, and review one-way folder syncs. Built with Electron, native storage adapters, and a persistent SQLite transfer queue.

![S3 Browser](assets/welcome.png)

## Install

[Releases](https://github.com/bigpod98/S3Browser/releases) provide **DEB, RPM, Arch and portable archives for Linux x86_64 and ARM64**, with a `SHA256SUMS` file. Packages and checksums are not signed: the checksums detect corrupted downloads, not a compromised release host. The features below describe the current source, which may be newer than the latest release. See [CI and release setup](packaging/README.md#github-actions-and-releases) for how releases are built and validated.

Building from source places native Linux packages in `dist/native/`:

| Distribution    | Package                                      | Install                                                                   |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Arch / ALPM     | `alpm/s3-browser-0.1.1-1-x86_64.pkg.tar.zst` | `sudo pacman -U ./dist/native/alpm/s3-browser-0.1.1-1-x86_64.pkg.tar.zst` |
| Debian / Ubuntu | `deb/s3-browser_0.1.1-1_amd64.deb`           | `sudo apt install ./dist/native/deb/s3-browser_0.1.1-1_amd64.deb`         |
| Fedora / RPM    | `rpm/s3-browser-0.1.1-1.x86_64.rpm`          | `sudo dnf install ./dist/native/rpm/s3-browser-0.1.1-1.x86_64.rpm`        |

After installation, open **S3 Browser** from your application menu or run `s3-browser`. Your connections and transfer history stay in your user profile when the package is removed. See [packaging documentation](packaging/README.md) for build and validation details.

The table shows x86_64 filenames; ARM64 builds use `arm64` for DEB and `aarch64` for RPM/Arch.

A portable alternative is `s3-browser-0.1.1-linux-x64.tar.gz` (`linux-arm64.tar.gz` for ARM64): extract it and open `s3-browser` inside the extracted folder. Keep its accompanying files together, including its license notices. After `npm run pack`, `dist/linux-unpacked/s3-browser` can also be launched directly.

To run from source, install Node.js 22.13 or later and a recent npm:

```sh
npm ci
npm start
```

If your npm configuration blocks Electron's install script, run `node node_modules/electron/install.js` once. A graphical desktop is required. Chromium's sandbox remains enabled in normal use.

## Connect and upload

1. Choose **Connect your storage**, select the provider, and enter your credentials and endpoint.
2. Select a bucket or enter its name directly. A default bucket avoids requiring permission to list every bucket.
3. Browse to the destination and choose **Upload**. Choose an entire folder or multiple files, set a prefix and concurrency, and choose whether to skip or replace existing keys.
4. Select your local source in the native file picker. The app scans it into a durable queue without loading file contents.
5. Review the destination and object count in **Transfers**, then choose **Start upload**. Use **Pause**, **Resume upload**, **Retry failed**, **Cancel**, and **Details** as needed. **Settings** controls concurrency, bandwidth, and additional attempts; **Export failures** saves a JSON failure report.

Selecting `/home/me/Photos` at prefix `archive/` creates:

```text
archive/Photos/
archive/Photos/2026/
archive/Photos/2026/image.jpg
archive/Photos/empty-folder/
```

The selected folder's own name is included. Nested paths, Unicode names, hidden files, file contents, and empty directories are preserved. S3 stores object keys, so directories are represented by zero-byte keys ending in `/`. Symlinks and special files are skipped and counted. Filesystem permissions, ownership, hard-link relationships, and modification times are not restored as filesystem metadata. Source files must remain available and unchanged until their upload finishes.

## Browse, select, and download

Use the prefix field to navigate directly, **Bookmark** to save a connection/bucket/prefix location, and the recent-location shortcuts to revisit previous locations. Bookmarks and recent locations persist locally.

Checkboxes select files or folders; the header checkbox selects visible rows. Selection resets when loading another page or location. Name, size, and date sorting applies to the loaded page, with folders first. The normal browser loads up to 500 entries per page, and typing in its filter narrows that page. **Search prefix** searches object keys recursively beneath the current prefix, case-insensitively. Each search request scans at most five pages of 500 keys; use the next-page control to continue even when a batch has no matches. Sorting search results also applies only to the current result batch.

Choose **Download selected** or an object's download button, select skip or replace for existing local files, and choose a local destination folder. A selected remote folder expands across all listing pages. Paths relative to the current remote prefix are preserved, overlapping selections are deduplicated, and empty folder markers create local directories. Start the resulting download batch in **Transfers**.

Downloads use temporary files and publish completed files only after checking the expected size. Remote ETag conditions detect changed source objects. Unsafe or nonportable names, case/Unicode path collisions, file/folder conflicts, and destination symlinks are rejected; some valid S3 keys therefore cannot be downloaded through this workflow. Downloads restore bytes and directory structure, without restoring filesystem ownership, permissions, or timestamps.

## Organize objects

**+ Folder** creates a zero-byte folder marker. **Copy**, **Move**, and **Delete** expand selected folders recursively and show the exact object keys for confirmation. Copy and move accept a destination bucket and prefix on the current connection and preserve paths relative to the current source prefix. Existing destination objects are never replaced; choose a different destination when a key conflicts. Overlapping source and destination selections are rejected.

Operations recheck reviewed source snapshots and send conditional requests. A move copies each object, verifies its destination size and returned ETag/version, then conditionally deletes its source. S3 large objects use multipart server-side copy. Native providers use their own copy APIs; Swift copies stream through this device. These batches are not atomic: successful objects remain processed if another object fails, and a failed move can leave a destination copy with the source retained. The result identifies failures for review. Operations run directly after confirmation; they are not durable, pausable transfer jobs. Preview tokens expire after one hour or when the app closes.

## Object details and maintenance

Click an object name to inspect its size, ETag, storage class, content type, and user metadata. Editing metadata replaces the whole user metadata map while preserving object bytes and supported existing attributes. S3/GCS use server-side copy; Azure block blobs stream through this device. Review and confirm the replacement before saving. Saving checks a connection-bound snapshot of the displayed metadata and object headers; if another client changed the object while the editor was open, reopen its details and review again. S3 copy conditions guard the ETag, so a metadata-only write in the narrow interval between the final check and the copy cannot be excluded atomically.

The same dialog can generate and copy an expiring download link, with a lifetime from one second to seven days. Anyone holding the link can download the object until it expires; temporary credentials may expire sooner. Version history supports pagination and restoring a selected data version as a new current version. Delete markers cannot be restored, and history requires provider support and bucket versioning.

**Multipart cleanup** lists unfinished uploads with pagination. Select uploads, review the list, and confirm aborting them to release their unfinished parts. It does not delete completed objects. Listing, versioning, metadata copy, conditional requests, and multipart APIs vary by provider and permissions; unsupported or denied operations report errors. Configure an incomplete-multipart lifecycle rule as well to cover remnants after crashes or network loss.

## Review a one-way folder sync

Choose **Sync folder**, select a local folder, and inspect the comparison before **Confirm & queue sync**. Sync maps the folder's **contents** directly into the current prefix: `/home/me/Photos/image.jpg` at `archive/` becomes `archive/image.jpg`. Ordinary folder upload includes `Photos/` as shown above. Sync is an explicit one-way local-to-remote operation, without watching the folder or downloading remote changes.

The preview classifies new, changed, unchanged, remote-only, conflicting, and skipped paths. It reads local files to calculate checksums, compares sizes and supported full-object checksums or suitable single-part MD5 ETags, and treats uncertain equality as changed. Multipart ETags are not treated as file MD5 hashes. Symlinks and special files are skipped; remote paths overlapping skipped or conflicting local paths are protected from deletion.

Remote deletion is **off by default**. Enabling it includes reviewed remote-only keys in the plan. Applying rechecks the local tree and remote snapshots, then creates a transfer batch for new and changed entries. Start that batch in **Transfers**. New keys use create-only conditions and replacements use the reviewed ETag, so changed remote targets fail instead of being overwritten unconditionally. Local source checks also run before upload; keep the source unchanged throughout the run. New sync uploads store an operation identifier and the intended SHA-256 in the `s3browser-upload-token` and `s3browser-sha256` user metadata fields. After an interrupted or ambiguous write, recovery requires that identifier, checksum, size, and a streamed SHA-256 of the remote bytes all match before accepting the upload as completed. Verification needs object read permission and can download the whole object. Older interrupted uploads without this evidence require a fresh comparison; an existing object alone is never treated as proof of success.

Reviewed deletions run only after every queued upload succeeds. Before cleanup, the app checks the local tree and deletion targets again, then conditionally deletes matching remote objects. A failed upload prevents cleanup; changed sources or deletion targets stop cleanup. Sync plans and cleanup status survive restarts, and failed cleanup can be retried from **Transfers**. Pause and closing the app interrupt cleanup validation and remote requests, and prevent further deletions from starting. A deletion already accepted by the server may still complete. Resume skips already absent objects and continues with the remaining reviewed keys. Cancel stops the sync permanently; compare again to start a new sync. Sync is not a transaction: completed uploads and deletions are retained after later failures.

## Providers

| Provider       | Endpoint                                                                                    | Region                                        | Path-style    |
| -------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------- |
| Cloudflare R2  | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (or your jurisdiction-specific S3 endpoint) | `auto`                                        | Usually off   |
| Amazon S3      | Leave blank for the AWS endpoint                                                            | Your bucket's region                          | Usually off   |
| Ceph RGW       | Your gateway, e.g. `https://s3.example.com`                                                 | Your deployment's region; default `us-east-1` | On by default |
| MinIO / custom | Your S3 API endpoint, including port if needed                                              | Your deployment's region                      | On by default |

For R2, use **S3 access key ID and secret**, not a general Cloudflare API bearer token. See [Cloudflare's SDK configuration](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/). Ceph must expose its [Object Gateway S3 API](https://docs.ceph.com/en/latest/radosgw/), not a Swift endpoint. Compatibility varies by server/version and enabled features.

The following providers use their native APIs. Select the provider in **New connection** to see its credential fields. Azure and Swift containers appear in the same browser location controls as S3/GCS buckets. A default container or bucket bypasses account-wide listing.

| Provider             | Connection fields                                                                                                                            | Notes                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenStack Swift      | Existing token and account storage URL, or Keystone URL, username, password, project name, domain, and optional region; optional TempURL key | Keystone connections refresh tokens automatically. Existing-token connections retain **Refresh Swift token** so queued batches keep their connection identity.                 |
| Azure Blob Storage   | Account name with account key or SAS token, or a Blob connection string                                                                      | Account key/SAS connections allow a custom Blob service endpoint. Connection strings supply their own endpoint. Generating new download links requires shared-key credentials. |
| Google Cloud Storage | Service account JSON, absolute path to a key file, or explicitly selected Application Default Credentials                                    | A project ID is required for key-file/default authentication; pasted JSON can supply it. Uses the standard Google API with generation/metageneration preconditions.            |

Google Cloud Storage has [partial S3 interoperability through its XML API](https://docs.cloud.google.com/storage/docs/interoperability). The dedicated provider uses the native API instead, so it does not require S3 HMAC credentials or assume that all S3 operations are compatible.

| Workflow                                                                   | Azure Blob Storage                       | Google Cloud Storage                    | OpenStack Swift                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| Browse, prefix search, bookmarks, queued uploads/downloads, folder markers | Yes                                      | Yes                                     | Yes                                                                               |
| Reviewed copy                                                              | Yes                                      | Yes                                     | Yes, streamed through this device                                                 |
| Reviewed move/delete and sync deletion                                     | Yes                                      | Yes                                     | Unavailable: no supported atomic ETag deletion guard                              |
| Metadata inspection                                                        | Yes                                      | Yes                                     | Yes                                                                               |
| Reviewed metadata replacement                                              | Block blobs; streams through this device | Yes                                     | Unavailable: no supported ETag replacement guard                                  |
| Version history and restore                                                | When account versioning is enabled       | When bucket versioning retains versions | Unavailable in this adapter                                                       |
| Expiring download links                                                    | Read-only SAS                            | V4 signed URL                           | Requires a configured TempURL key and SHA-256 support                             |
| Reviewed folder sync                                                       | Yes                                      | Yes                                     | Comparison and new-object uploads; plans requiring replacements cannot be applied |
| S3 multipart inspection/cleanup                                            | Unavailable                              | Unavailable                             | Unavailable                                                                       |

Swift uploads use the cluster's single-object PUT limit. The adapter checks `/info` and falls back to 5 GiB when discovery is unavailable, rejecting oversized files before uploading. Segmented large-object uploads are not implemented. Ordinary upload **Replace existing** remains available and intentionally overwrites the destination. Reviewed sync replacements, move/delete, and metadata changes are disabled where Swift cannot enforce their conditions. The adapter never drops a required guard to make an operation succeed. See the [Swift Object Storage API](https://docs.openstack.org/api-ref/object-store/) for the underlying operations.

Azure uploads use native staged blocks and GCS uses resumable uploads. Pause/resume still restarts an unfinished file from byte zero. Azure/GCS incomplete uploads do not appear in the S3 multipart cleanup dialog. Azure-compatible metadata names and ASCII values remain unchanged. Names or values outside Azure's restrictions use reversible encoding; other clients see that encoded representation. Azure metadata replacement transfers the object through this device to atomically commit the reviewed bytes, headers, and metadata. Azure sync comparisons trust the stored Content-MD5 property, which other clients can change independently of the bytes; uploads from this app calculate it from the streamed contents. GCS ETags displayed by this app are opaque generation/metageneration tokens, not content hashes.

Pasted credentials, including Keystone passwords, Swift tokens/TempURL keys, Azure keys/SAS tokens/connection strings, and GCS JSON keys, use OS-keyring encryption or session-only storage. They are excluded from public connection data and transfer manifests. Google key-file paths are also encrypted; the referenced files and Application Default Credentials remain managed outside the app.

Keystone uses the [Identity v3 password flow](https://docs.openstack.org/api-ref/identity/v3/) and the public object-store endpoint for the selected region. A refresh that changes the account endpoint or project is rejected. Read requests can retry once after token rejection; streamed writes use the durable queue's retry handling instead of replaying a consumed stream. Azure authentication follows the [Blob SDK connection options](https://learn.microsoft.com/en-us/javascript/api/overview/azure/storage-blob-readme). Google default authentication must be selected explicitly; an empty JSON field never silently falls back to [Application Default Credentials](https://docs.cloud.google.com/storage/docs/authentication).

Credentials need bucket listing permission for browsing, object write permission for uploads, object read permission for downloads and skip-existing checks, and multipart upload/abort permission for large files. Copy and metadata workflows may also need tagging permissions; deletes, version access, and multipart listing need their respective permissions. Listing all buckets is optional. A `403` on an existence check is treated as a failure rather than assuming the object is missing. Skip uploads send `If-None-Match: *`; ordinary upload replace mode intentionally permits overwrites. Reviewed operations and sync retain their conditional guards and do not retry without them when a provider rejects them.

These guards protect only when the provider enforces them. The app sends ETag, create-only, and generation preconditions, but cannot detect a server that accepts the request and silently ignores them; such a server then overwrites or deletes unconditionally. Amazon S3, Azure Blob Storage, and Google Cloud Storage document these conditions. Before relying on reviewed sync replacement or deletion, move, delete, or metadata replacement on another S3-compatible server, confirm that its version honors `If-Match`, `If-None-Match`, and copy-source conditions.

HTTPS uses normal certificate validation. Private CAs can be supplied through `NODE_EXTRA_CA_CERTS` when launching from a configured environment.

## Queue behavior and limits

- SQLite stores upload/download manifests and each object's status, not file contents or credentials. Transfer details are paginated in groups of 100. Upload folder scanning inserts entries in bounded batches. Download, operation, and sync previews materialize their manifests in memory; very large selections can take substantial time and memory, especially sync hashing and full review lists. Split large workloads into smaller prefixes when practical.
- Default concurrency is six files, configurable from one to sixteen in **Settings**. Each large S3 upload uses one multipart worker with parts of at least 8 MiB, increased for large objects to stay within 10,000 parts. Native Azure/GCS uploads use 8 MiB blocks/chunks (Azure increases block size for large files). Active-transfer buffering depends on concurrency and part size. A bandwidth limit in MiB/s is shared across the batch's workers; zero means unlimited. Displayed speed and ETA are estimates.
- The S3 SDK retries transient request failures up to five attempts. Queue settings add zero to ten whole-file retries, defaulting to two, on top of request retries. Failed entries remain visible for manual retry or JSON export.
- Pause interrupts active file requests and attempts to clean up multipart uploads. Resume restarts unfinished files from byte zero. Completed objects stay completed. Cancel stops unfinished work without undoing completed objects. This is file-level recovery, not multipart byte-offset recovery.
- Closing the app pauses the queue; reopening never automatically starts transfers. **Automatically start the next queued batch** is opt-in for the current session, and the first batch must be started manually. Pausing disables automatic progression. A crash during a scan requires selecting the source again; interrupted file transfers recover as pending.
- Ordinary upload and download skip modes check destination existence, not content equality. Their replace modes intentionally overwrite matching destinations. Uploading alone does not delete unrelated remote objects; remote deletion is a separate reviewed operation or an explicitly enabled sync option.
- One transfer batch runs at a time. You can browse or prepare other batches while transferring. The app prevents system idle suspension during an active batch, but cannot prevent shutdowns or all lid-close policies.
- Saved credentials are encrypted with Electron's OS-backed secure storage. On Linux, insecure `basic_text` storage is rejected. Without an OS keyring, use session-only credentials. After restarting, session-only connections are gone; create a new connection and batch with skip-existing enabled to continue. Locked saved connections become usable after unlocking the keyring and restarting.
- Queue and sync metadata include local paths and remote keys, stored alongside bookmarks and recent locations in Electron's application data directory (`~/.config/s3-browser` on typical Linux installations). This metadata is not encrypted. Removing a batch only removes local history, not transferred objects or files.

## Development and verification

```sh
npm test              # Unit tests; service-backed integrations skip without endpoints
npm run test:desktop  # Electron smoke test; requires a display
npm run test:desktop:providers # Provider form smoke; headless Chromium, no cloud account
npm run test:desktop:expansion # Expanded workflows; requires a display and S3_TEST_ENDPOINT
npm run dist          # Native DEB, RPM and ALPM packages (requires Docker)
npm run dist:portable # Portable Linux tar.gz archive
npm run pack          # Unpacked desktop application
```

Backend integration tests use disposable local MinIO and Azurite services. Install them once; this requires Go and npm, builds MinIO from a pinned upstream commit with Go 1.25.5, and installs Azurite 3.35.0 under `~/.cache/s3browser-test-services` (override with `S3BROWSER_TEST_SERVICE_DIR`), outside the project lockfile:

```sh
bash scripts/ci/install-test-services.sh
```

The helper then starts fresh loopback services with temporary storage, exports the `S3_TEST_*` and `AZURITE_*` test settings, runs the given command, and stops and removes the services afterwards. It never uses an existing endpoint:

```sh
bash scripts/ci/with-test-services.sh npm test
bash scripts/ci/with-test-services.sh npm run test:desktop
bash scripts/ci/with-test-services.sh npm run test:desktop:expansion
bash scripts/ci/with-test-services.sh npm run test:scale
```

The full CI gate is `bash scripts/ci/with-test-services.sh bash scripts/ci/check.sh`. It reinstalls dependencies with `npm ci`, installs Playwright's Chromium and its system packages, and disables Chromium's sandbox for the Electron suites, so run it as root only in a disposable Linux container with the packages from `scripts/ci/install-deps.sh`, as CI does.

Desktop tests save screenshots to the ignored `test-results/desktop` directory. Set `S3_TEST_REFRESH_ASSETS=1` to deliberately regenerate the documentation images in `assets/`. The opt-in scale test creates 49,500 small files and 500 directories, uploads and counts all 50,000 objects, then removes its temporary bucket and local files. Tests issue writes, reads, and deletes only in buckets and containers they create.

The backend and expansion suites exercise Unicode paths, empty folders, multipart uploads, queued downloads, skip/replace behavior, source-change rejection, copy/move/delete, metadata replacement, signed-link downloads, recursive search across 2,505 keys, reviewed sync and conditional cleanup, version restore, and multipart abort against MinIO. Unsupported bucket versioning may be skipped on other backends. Large multipart-copy branches are covered with simulated SDK responses rather than live multi-gigabyte objects. The desktop smoke test uses the real Electron window and actual IPC.

Native provider tests cover Swift against a local HTTP fixture, Azure SDK calls and the Azurite emulator, and GCS authenticated API requests plus the installed SDK’s resumable upload preconditions. The headless provider form test uses the real renderer with an IPC fixture; install Chromium with `npx playwright install chromium` if needed.

Not covered by automated tests: live Amazon S3, R2, Ceph, Azure, Google Cloud Storage, and Swift accounts, and Windows/macOS builds, whose targets are configured but not built.

## License

S3 Browser is released under the [MIT License](LICENSE), copyright 2026 Primož Ajdišek (bigpod).

Builds also contain Electron, Chromium, and npm production dependencies under their own licenses. Portable archives include `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `LICENSE.electron.txt`, and `LICENSES.chromium.html` beside the executable; native packages also install them in `/usr/share/licenses/s3-browser/`. `THIRD_PARTY_NOTICES.txt` is generated during each build from the locked, installed production dependencies; see [license notices](packaging/README.md#license-notices).
