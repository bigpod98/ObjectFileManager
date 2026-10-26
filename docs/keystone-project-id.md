# Keystone project-ID scope

The desktop Keystone form has one domain field. When authenticating with a
project name, the adapter uses that domain for both the user and the project.
For a user and project in different domains, use the existing `projectId`
profile field to identify the project without a project-domain lookup.

For an existing remembered Keystone connection:

1. Quit ObjectFileManager and back up `connections.json` from the application's
   user-data directory (normally `~/.config/objectfilemanager` on Linux).
2. Find the connection in the JSON array using its `id` or `name` and set its
   top-level `projectId` to the project's ID. Keep the other fields, including
   the encrypted `credentials` value, intact.
3. Set `domainName` to the **user's** domain. If the user domain must be
   identified by ID, set `domainId` instead; it takes precedence over
   `domainName`.
4. Restart ObjectFileManager and select the connection.

`projectId` takes precedence over `projectName`. It produces a project scope
of `{ "id": "<project-id>" }`, with no domain attached. The domain continues
to apply to the username/password identity. This is an existing profile-level
workaround; the connection form does not expose project-ID or domain-ID fields.

Regression coverage in `test/keystone.test.cjs` checks that a project ID wins
over a supplied project name and that the user's domain ID is used only in
the identity.
