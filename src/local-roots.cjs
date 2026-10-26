const fs = require("node:fs/promises");
const path = require("node:path");

const rootIdentity = (stat) =>
  JSON.stringify({
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
  });

async function validateRoot(root, expected) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root)
    throw new Error("Selected root must be an absolute canonical folder.");
  let stat;
  for (let current = root; ; current = path.dirname(current)) {
    const ancestor = await fs.lstat(current);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink())
      throw new Error(
        "Source parent changed or became a symbolic link. Create a new batch.",
      );
    if (current === root) stat = ancestor;
    if (current === path.dirname(current)) break;
  }
  if (expected && rootIdentity(stat) !== expected)
    throw new Error(
      "Selected root changed since selection. Create a new batch.",
    );
  return stat;
}

async function selectRoot(selected, allowAlias = false) {
  selected = path.resolve(selected);
  const before = await (allowAlias ? fs.stat(selected) : fs.lstat(selected));
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new Error(
      "Selected folder must be a directory; symbolic links are not supported.",
    );
  // Resolve user-selected ancestors once. Persist the canonical path so later
  // retargeting an alias cannot redirect queued work to another tree.
  const root = await fs.realpath(selected);
  const identity = rootIdentity(before);
  await validateRoot(root, identity);
  return { root, rootIdentity: identity };
}

async function validateParents(source, root, expected) {
  if (root) {
    const relative = path.relative(root, source);
    if (
      !path.isAbsolute(source) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error(
        "Source is outside its original folder. Create a new batch.",
      );
    await validateRoot(root, expected);
    if (!relative) return;
  }
  for (
    let current = path.dirname(path.resolve(source));
    ;
    current = path.dirname(current)
  ) {
    if (current === root) break; // The root and its ancestors were checked above.
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        "Source parent changed or became a symbolic link. Create a new batch.",
      );
    if (current === path.dirname(current)) break;
  }
}

// Path checks narrow races but Node has no portable openat/renameat API to bind
// every descendant operation to a directory handle. A concurrent local process
// can still replace an ancestor between a check and a filesystem operation.
module.exports = { selectRoot, validateRoot, validateParents };
