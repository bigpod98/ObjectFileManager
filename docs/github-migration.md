# Moving to GitHub

The prepared destination is `https://github.com/bigpod98/ObjectFileManager`. These changes
update project links, move workflows from `.forgejo/workflows` to
`.github/workflows`, and adapt release publishing to GitHub.com. Preparation does
not create a repository, change remotes, push source, or change visibility.

## Repository setup

Create an **empty** `bigpod98/ObjectFileManager` repository with the desired visibility.
Do not initialize a README, license, or `.gitignore`; they already exist here.
Commit the migration changes locally before transferring `main`.

Keep the Forgejo remote available while checking the move:

```sh
git remote add github https://github.com/bigpod98/ObjectFileManager.git
git push github main:main
```

Push only branches and tags you intend to publish. Avoid `--mirror`: local
development branches and other refs do not all belong in the public repository.
Pushing a `v*` tag triggers the new release pipeline when that tag contains the
GitHub workflow. Old tags retain their original source and workflow files;
moving the default branch does not retroactively migrate them.

After the GitHub copy is verified, make it the default remote if desired:

```sh
git remote rename origin forgejo
git remote rename github origin
git fetch origin
git branch --set-upstream-to=origin/main main
```

## GitHub configuration and first run

- Set `main` as the default branch and enable GitHub Actions. The workflows use
  standard GitHub-hosted `ubuntu-24.04` and `ubuntu-24.04-arm` runners.
- Keep default workflow permissions read-only. The release publication job
  explicitly requests `contents: write`; no personal access token is needed.
- Require approval for outside-contributor workflow runs. CI uses the
  `pull_request` event and does not receive publication credentials.
- After the first successful CI run, configure a ruleset for `main` with the
  `check` job as a required check, and restrict who can create or modify release
  tags. Choose bypass rules appropriate for the maintainer's workflow.
- Verify the first branch CI run, then the next intended stable release. A
  release builds and tests both architectures before publishing eight packages
  and `SHA256SUMS`. Do not create a tag just to test migration unless a release
  is intended. See [release setup](../packaging/README.md#github-actions-and-releases).

Workflow syntax, unit tests and local packaging checks cannot validate account
settings, runner availability or a live GitHub upload. Those require the actual
repository and workflow runs after migration.

## Data outside Git

Git pushes transfer source history. Forgejo issues, pull requests, release notes
and uploaded assets, repository settings, secrets, stars and watchers are not
included. Decide separately whether to migrate those records or keep the Forgejo
repository available as a historical archive. Existing binary releases can be
copied separately when authorized; this preparation does not rebuild or publish
historical releases.

The application/desktop ID is `com.tuxbase.objectfilemanager`. The maintainer's
name, contact address, and MIT copyright are independent of repository hosting.

The [open-source review](open-source-review.md) records validation of the earlier
Forgejo version. GitHub workflow execution must be verified separately.

## Local preparation validation

Both workflows passed `actionlint` 1.7.7. All 17 targeted release, package-target
and dependency-notice tests passed, along with `npm run check` and
`git diff --check`. Release tests use a simulated GitHub API, including draft
recovery, pagination, annotated tags, raw uploads, credential-free download
redirects and checksum verification. No live GitHub release was created and
native packages were not rebuilt for this hosting-only change.

References: [GitHub Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository),
[hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
and [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).
