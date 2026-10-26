# Object Lock copy policy

ObjectFileManager carries the source's returned `ObjectLockMode`,
`ObjectLockRetainUntilDate`, and `ObjectLockLegalHoldStatus` into both
`CopyObject` and `CreateMultipartUpload`. This includes ordinary copy/move,
version restore, and metadata replacement. Other retained attributes keep their
existing behavior. Source protection is never bypassed or removed.

This is an explicit application policy. S3 copy does not automatically inherit
Object Lock settings; the destination's bucket configuration and permissions
also affect the result. The application can preserve only fields returned by
the source HEAD request. Appropriate Object Lock read and write permissions are
required. An incompatible destination fails rather than receiving a less
protected retry. See AWS's [copying documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/copy-object.html),
[CopyObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html),
and [multipart creation API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html).

Expired retention remains metadata even though its protection period has ended.
The application sends the original date unchanged. A service that rejects a past
retain-until date stops the copy; there is no automatic removal of retention
fields. A legal hold remains independent of retention expiry and is preserved
as well. Changing expired-retention handling would require an explicit product
policy and reviewed user-visible behavior. See AWS's [Object Lock model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html).

## Verification

On disposable MinIO built from commit
`07c3a429bfed433e49018cb0f78a52145d4bedeb`, direct service probes accepted active
GOVERNANCE retention and legal hold ON through both CopyObject and multipart
creation. Both APIs rejected an expired explicit retention date with
`InvalidRequest` / HTTP 400. A probe also let a source's retention expire before
copying it and observed the same rejection. This is measured MinIO behavior;
live AWS and other S3-compatible services were not tested.

`test/object-lock.test.cjs` verifies that small and multipart paths pass active,
expired, COMPLIANCE, and combined hold/retention settings without weakening
them. Rejected expired retention makes only one creation attempt. The optional
service test checks actual small-copy target protection and both APIs' explicit
date validation. Multipart completion with multi-gigabyte locked objects is
covered by simulated SDK responses, not a live large-object transfer.

Run the service regression against fresh disposable backends:

```sh
bash scripts/ci/with-test-services.sh node --test test/object-lock.test.cjs
```
