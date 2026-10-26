# S3 request timeouts

S3-compatible connections use the AWS SDK's existing Node HTTP handler. No extra
dependency or custom transport is needed. The limits apply separately to each SDK
attempt:

- **Connection: 15 seconds.** An attempt that cannot establish its connection is
  closed.
- **Socket inactivity: 2 minutes.** A connected socket with no traffic is closed,
  including a download that stops sending bytes after its response headers.
- **Request duration: 24 hours, enforced.** An upload must receive its response
  headers within this limit, including time spent sending its body. This also
  bounds a request awaiting a socket. `throwOnRequestTimeout: true` makes expiry
  destroy the request and reject with `TimeoutError`, rather than merely logging
  a warning.

The previous 2-minute `requestTimeout` was warning-only in the installed handler.
Simply enabling enforcement at that duration would also reject healthy large or
bandwidth-limited uploads. The longer, finite request limit allows those uploads
while the separate inactivity limit detects stalls promptly. The request limit
also prevents an upload or pre-header response from occupying an attempt forever
by trickling bytes often enough to avoid the inactivity limit.

These are transport bounds, not a guarantee that every bandwidth setting works.
An intentionally throttled transfer that leaves its socket idle for more than two
minutes can time out; an upload taking more than 24 hours in one HTTP attempt can
also time out. Shared bandwidth, chunk size and concurrency affect those pauses.
Increase bandwidth or reduce concurrency if intentional throttling causes idle
failures. Multipart uploads have an independent deadline for each part/request,
rather than one 24-hour deadline for the entire file or queue.

The installed handler clears its request-duration timer once response headers
arrive. Streaming downloads therefore have no total wall-clock limit: they may
run longer while bytes keep arriving, and the inactivity timeout still closes
stalled bodies. A timeout after the SDK returns a GET body is a stream error;
the SDK does not transparently replay an already returned partial body. Queue
retry and recovery remain responsible for restarting that transfer safely.

`maxAttempts: 5` remains unchanged. Connection, request and idle timeouts before
the response are retryable through the SDK's normal retry policy when the request
can be replayed. The SDK cannot safely retry a consumed streaming upload body;
queue retries must reopen its validated source instead. Five attempts and retry
backoff can exceed any single-attempt limit. Caller cancellation still destroys
the active request/body and stops retries. There is no new timeout
configuration in profiles and no change to the other providers.

## Implementation evidence and tests

Inspected the installed `@smithy/node-http-handler` **4.12.1** implementation:
`node-http-handler.js`, `set-request-timeout.js`, `set-socket-timeout.js`,
`set-connection-timeout.js`, and `write-request-body.js` under its `dist-es`
directory, plus `@smithy/types/dist-types/http/httpHandlerInitialization.d.ts`.
The AWS SDK builds this handler from constructor options, so the application
does not import an undeclared transitive dependency. See AWS's
[request-handler shorthand documentation](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/node-configuring-maxsockets.html),
the Smithy
[timeout option definitions](https://github.com/smithy-lang/smithy-typescript/blob/main/packages/types/src/http/httpHandlerInitialization.ts),
and its
[request timeout implementation](https://github.com/smithy-lang/smithy-typescript/blob/main/packages/node-http-handler/src/set-request-timeout.ts).

Run `node --test test/s3-timeouts.test.cjs`. The tests use the real SDK and local
HTTP servers, shortening handler settings through its public configuration API
instead of waiting minutes or hours. They check the production limits, all five
SDK attempts on enforced request expiry, successful retry after an idle timeout,
response-header trickles, stalled streaming uploads, body stalls after headers,
active throttled uploads, long streaming downloads, and cancellation before and
after response headers.
