# Contributing

Bug reports, fixes, and focused improvements are welcome. Use the [issue tracker](https://github.com/bigpod98/S3Browser/issues) for bugs and proposals, and open pull requests against `main` on [GitHub](https://github.com/bigpod98/S3Browser). Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Development setup

Use Node.js 22.13 or later and install locked dependencies:

```sh
npm ci
npm start
```

If your npm configuration blocks Electron's install script, run `node node_modules/electron/install.js` once.

## Before opening a pull request

```sh
npm run check                     # Prettier formatting
npm test                          # Unit tests; service-backed tests skip without endpoints
npm run test:desktop:providers    # Provider form smoke; headless Chromium
```

Changes to storage, transfer, sync, or provider behavior should also pass the integration suites against disposable local services. Install the services once (requires Go and npm; nothing is added to the project lockfile), then run commands through the helper, which starts fresh loopback MinIO and Azurite instances and removes them afterwards:

```sh
bash scripts/ci/install-test-services.sh
bash scripts/ci/with-test-services.sh npm test
bash scripts/ci/with-test-services.sh npm run test:desktop           # needs a display
bash scripts/ci/with-test-services.sh npm run test:desktop:expansion # needs a display
```

Desktop tests write screenshots to the ignored `test-results/desktop` directory. Only set `S3_TEST_REFRESH_ASSETS=1` when you intend to update the documentation images in `assets/`.

Never point tests at real cloud accounts or production buckets. Do not include credentials, access tokens, signed URLs, or private endpoints in issues, logs, fixtures, or screenshots.

## Guidelines

- Keep pull requests focused, and add or update tests for behavior changes and regressions.
- Preserve safety guarantees: reviewed operations must not drop conditional guards, credentials must not reach transfer manifests or logs, and Chromium's sandbox stays enabled outside disposable test containers.
- Update `README.md` or `packaging/README.md` when user-visible behavior, limits, or packaging change.
- Dependency changes must keep `package-lock.json` consistent. Production dependencies are listed in the generated `THIRD_PARTY_NOTICES.txt`; a new dependency without a license file needs a reviewed entry in `packaging/licenses/upstream.json` (see [license notices](packaging/README.md#license-notices)).
- CI executes code from your pull request; see [runner isolation](packaging/README.md#untrusted-pull-requests-and-runner-isolation). Maintainers may hold CI for changes to workflows, scripts, or dependencies until reviewed.

## License

By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).
