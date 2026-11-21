import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const releaseIdPattern = /^v[0-9]{4,}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd,
    encoding: options.encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

export function isSafeRepoPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.normalize("NFC") !== value
  ) {
    return false;
  }
  return value.split("/").every(
    (part) =>
      part.length > 0 &&
      part !== "." &&
      part !== ".." &&
      /^[A-Za-z0-9._-]+$/.test(part) &&
      !part.endsWith("."),
  );
}

export function parseNameStatus(raw) {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const paths = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    for (let pathIndex = 0; pathIndex < paths; pathIndex++) {
      changes.push({ status: status[0], path: fields[index++] });
    }
  }
  return changes;
}

export function allowedAddedPath(path, policy) {
  if (!isSafeRepoPath(path)) return false;
  const versionRoot = policy.versionRoot ?? "versions";
  const manifestRoot = policy.manifestRoot ?? "release-manifests";
  return (
    new RegExp(`^${escapeRegExp(versionRoot)}/v[0-9]{4,}/[A-Za-z0-9._-]+/.+$`).test(path) ||
    new RegExp(`^${escapeRegExp(manifestRoot)}/v[0-9]{4,}\\.json$`).test(path)
  );
}

export function isProtectedTarget(targetPath, policy) {
  if (!isSafeRepoPath(targetPath)) return true;
  return (policy.protectedTargets ?? []).some((prefix) =>
    prefix.endsWith("/")
      ? targetPath.startsWith(prefix)
      : targetPath === prefix || targetPath.startsWith(prefix),
  );
}

export function verifySeedBytes(bytes, seed) {
  return bytes.length === seed.bytes && hash(bytes) === seed.sha256;
}

export function validateChanges(changes, existingPaths, policy) {
  const errors = [];
  const additions = [];
  const normalizedPaths = new Set(
    existingPaths.map((item) => item.normalize("NFC").toLowerCase()),
  );
  for (const change of changes) {
    if (change.status !== "A") {
      errors.push(`Only additions are allowed; ${change.status} ${change.path} is forbidden.`);
      continue;
    }
    if (!allowedAddedPath(change.path, policy)) {
      errors.push(`New files must be versioned source or release manifests: ${change.path}.`);
      continue;
    }
    if (normalizedPaths.has(change.path.normalize("NFC").toLowerCase())) {
      errors.push(`New path substitutes for an existing path: ${change.path}.`);
      continue;
    }
    additions.push(change.path);
  }
  return { errors, additions };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCli(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--base") result.base = argv[++index];
    else if (argv[index] === "--head") result.head = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!/^[a-f0-9]{40}$/.test(result.base ?? "")) {
    throw new Error("--base must be a full commit SHA.");
  }
  if (!/^[a-f0-9]{40}$/.test(result.head ?? "")) {
    throw new Error("--head must be a full commit SHA.");
  }
  return result;
}

function readGitFile(revision, filePath) {
  return git(["show", `${revision}:${filePath}`]);
}

function readTreeEntries(revision, filePath) {
  const output = git(["ls-tree", "-rz", "--full-tree", revision, "--", filePath], {
    encoding: "buffer",
  });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [metadata, entryPath] = entry.split("\t");
      const [mode, type, oid] = metadata.split(" ");
      return { mode, type, oid, path: entryPath };
    });
}

function treePaths(revision) {
  const output = git(["ls-tree", "-rz", "--full-tree", revision], {
    encoding: "buffer",
  });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
}

function listManifestPaths(revision, policy) {
  return treePaths(revision)
    .filter((entry) =>
      new RegExp(
        `^${escapeRegExp(policy.manifestRoot)}/v[0-9]{4,}\\.json$`,
      ).test(entry),
    )
    .sort((left, right) => releaseNumber(left) - releaseNumber(right));
}

function releaseNumber(filePath) {
  return Number(filePath.match(/v([0-9]+)/)?.[1] ?? 0);
}

function parseManifest(bytes, filePath, policy, previous) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { manifest: undefined, errors: [`${filePath} is not valid JSON.`] };
  }

  const releaseId = filePath.match(/\/(v[0-9]{4,})\.json$/)?.[1];
  if (!releaseId || manifest.releaseId !== releaseId) {
    errors.push(`${filePath} releaseId must match its path.`);
  }
  if (!releaseIdPattern.test(manifest.releaseId ?? "")) {
    errors.push(`${filePath} has an invalid releaseId.`);
  }
  if (manifest.schemaVersion !== 1) errors.push(`${filePath} schemaVersion must be 1.`);
  if (manifest.parentReleaseId !== (previous?.manifest?.releaseId ?? null)) {
    errors.push(`${filePath} must extend the latest preserved release manifest.`);
  }
  const expectedParentHash = previous?.bytes ? hash(previous.bytes) : null;
  if ((manifest.parentManifestSha256 ?? null) !== expectedParentHash) {
    errors.push(`${filePath} parent manifest checksum is incorrect.`);
  }
  if (
    manifest.baselineCommit !== policy.baselineCommit ||
    manifest.baselineTree !== policy.baselineTree
  ) {
    errors.push(`${filePath} must retain the protected baseline commit and tree.`);
  }
  if (
    manifest.seed?.path !== policy.seed.path ||
    manifest.seed?.version !== policy.seed.version ||
    manifest.seed?.bytes !== policy.seed.bytes ||
    manifest.seed?.sha256 !== policy.seed.sha256
  ) {
    errors.push(`${filePath} must retain the approved Genesis Seed identity.`);
  }
  if (!Array.isArray(manifest.activeVersions) || manifest.activeVersions.length > 2048) {
    errors.push(`${filePath} activeVersions must be a bounded array.`);
    return { manifest, errors, referencedSources: new Set() };
  }

  const activeTargets = new Map();
  const referencedSources = new Set();
  for (const item of manifest.activeVersions) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).sort().join(",") !==
        "component,sha256,sourcePath,targetPath,version"
    ) {
      errors.push(`${filePath} contains a malformed active version entry.`);
      continue;
    }
    const sourceMatch = item.sourcePath?.match(
      /^versions\/(v[0-9]{4,})\/([A-Za-z0-9._-]+)\/(.+)$/,
    );
    if (
      !sourceMatch ||
      !releaseIdPattern.test(item.version ?? "") ||
      sourceMatch[1] !== item.version ||
      sourceMatch[2] !== item.component ||
      !isSafeRepoPath(item.sourcePath) ||
      !isSafeRepoPath(item.targetPath) ||
      isProtectedTarget(item.targetPath, policy) ||
      !sha256Pattern.test(item.sha256 ?? "")
    ) {
      errors.push(`${filePath} contains an unsafe or invalid source mapping.`);
      continue;
    }
    if (activeTargets.has(item.targetPath)) {
      errors.push(`${filePath} maps more than one version to ${item.targetPath}.`);
    }
    activeTargets.set(item.targetPath, item);
    referencedSources.add(item.sourcePath);

    try {
      const sourceBytes = readGitFile(policy.head, item.sourcePath);
      const entries = readTreeEntries(policy.head, item.sourcePath);
      if (
        entries.length !== 1 ||
        (entries[0].mode !== "100644" && entries[0].mode !== "100755") ||
        entries[0].type !== "blob" ||
        hash(sourceBytes) !== item.sha256
      ) {
        errors.push(`${filePath} source checksum or file type is invalid for ${item.sourcePath}.`);
      }
    } catch {
      errors.push(`${filePath} source file is missing: ${item.sourcePath}.`);
    }
  }

  if (previous?.manifest?.activeVersions) {
    for (const oldItem of previous.manifest.activeVersions) {
      const replacement = activeTargets.get(oldItem.targetPath);
      if (!replacement) {
        errors.push(`${filePath} removes an active target instead of preserving its version.`);
      } else if (
        replacement.sourcePath !== oldItem.sourcePath &&
        replacement.version !== releaseId
      ) {
        errors.push(`${filePath} may replace a target only with a version from ${releaseId}.`);
      }
    }
  }
  return { manifest, errors, referencedSources };
}

function verify(policy, base, head) {
  const errors = [];
  if (!policy || policy.schemaVersion !== 1) {
    throw new Error("The trusted append-only policy is missing or invalid on the base branch.");
  }
  git(["cat-file", "-e", `${policy.baselineCommit}^{commit}`]);
  if (
    git(["rev-parse", `${policy.baselineCommit}^{tree}`], { encoding: "utf8" }).trim() !==
    policy.baselineTree
  ) {
    throw new Error("The protected baseline tree does not match the trusted policy.");
  }
  git(["merge-base", "--is-ancestor", policy.baselineCommit, base]);
  git(["merge-base", "--is-ancestor", base, head]);

  for (const revision of [policy.baselineCommit, base, head]) {
    const seed = readGitFile(revision, policy.seed.path);
    if (!verifySeedBytes(seed, policy.seed)) {
      errors.push(`Genesis Seed bytes changed or are missing at ${revision}.`);
    }
  }

  const diff = git(["diff", "--name-status", "-z", "--no-renames", base, head], {
    encoding: "buffer",
  }).toString("utf8");
  const changes = parseNameStatus(diff);
  const additions = new Set();
  const checkedChanges = validateChanges(changes, treePaths(base), policy);
  errors.push(...checkedChanges.errors);
  for (const changedPath of checkedChanges.additions) {
    const entries = readTreeEntries(head, changedPath);
    if (
      entries.length !== 1 ||
      (entries[0].mode !== "100644" && entries[0].mode !== "100755") ||
      entries[0].type !== "blob"
    ) {
      errors.push(`Only regular files may be added: ${changedPath}.`);
      continue;
    }
    additions.add(changedPath);
  }

  const baseManifestPaths = listManifestPaths(base, policy);
  if (!baseManifestPaths.length) {
    throw new Error("No protected initial release manifest exists on the base branch.");
  }
  let previous;
  for (const manifestPath of baseManifestPaths) {
    const bytes = readGitFile(base, manifestPath);
    const parsed = parseManifest(bytes, manifestPath, { ...policy, head: base }, previous);
    if (parsed.errors.length) errors.push(...parsed.errors);
    previous = { manifest: parsed.manifest, bytes };
  }
  const previousPath = baseManifestPaths.at(-1);

  const newManifestPaths = [...additions]
    .filter((item) => item.startsWith(`${policy.manifestRoot}/`))
    .sort((left, right) => releaseNumber(left) - releaseNumber(right));
  const newVersionPaths = [...additions].filter((item) => item.startsWith(`${policy.versionRoot}/`));
  if (newVersionPaths.length && !newManifestPaths.length) {
    errors.push("Every new source version must be named by a new release manifest.");
  }
  if (!newManifestPaths.length && !newVersionPaths.length) {
    errors.push("The candidate contains no additive source version or release manifest.");
  }

  const referenced = new Set();
  const newVersionPathsByRelease = new Map();
  for (const sourcePath of newVersionPaths) {
    const match = sourcePath.match(/^versions\/(v[0-9]{4,})\//);
    if (!match) continue;
    const paths = newVersionPathsByRelease.get(match[1]) ?? new Set();
    paths.add(sourcePath);
    newVersionPathsByRelease.set(match[1], paths);
  }
  let expectedParent = previous;
  let expectedNumber = releaseNumber(previousPath) + 1;
  for (const manifestPath of newManifestPaths) {
    if (releaseNumber(manifestPath) !== expectedNumber) {
      errors.push(`${manifestPath} must be the next sequential release manifest.`);
      continue;
    }
    const releaseId = `v${String(expectedNumber).padStart(4, "0")}`;
    const releaseSources = newVersionPathsByRelease.get(releaseId) ?? new Set();
    if (releaseSources.size === 0) {
      errors.push(`${manifestPath} must introduce at least one source file in ${releaseId}.`);
    }
    const bytes = readGitFile(head, manifestPath);
    const parsed = parseManifest(bytes, manifestPath, { ...policy, head }, expectedParent);
    errors.push(...parsed.errors);
    for (const source of parsed.referencedSources) referenced.add(source);
    const manifestSources = new Set(
      (parsed.manifest?.activeVersions ?? [])
        .filter((item) => item?.version === releaseId && item?.sourcePath)
        .map((item) => item.sourcePath),
    );
    if (![...releaseSources].some((sourcePath) => manifestSources.has(sourcePath))) {
      errors.push(`${manifestPath} must activate a new ${releaseId} source version.`);
    }
    for (const sourcePath of releaseSources) {
      if (!manifestSources.has(sourcePath)) {
        errors.push(`${manifestPath} does not activate new source file ${sourcePath}.`);
      }
    }
    expectedParent = { manifest: parsed.manifest, bytes };
    expectedNumber++;
  }
  for (const sourcePath of newVersionPaths) {
    if (!referenced.has(sourcePath)) {
      errors.push(`New version source is not activated by a release manifest: ${sourcePath}.`);
    }
  }
  return { errors, additions: [...additions] };
}

function main() {
  const { base, head } = parseCli(process.argv.slice(2));
  const policy = JSON.parse(
    readGitFile(base, ".zioncore/append-only-policy.json").toString("utf8"),
  );
  const result = verify(policy, base, head);
  if (result.errors.length) {
    console.error("Append-only release check failed:");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Append-only release check passed: ${result.additions.length} new immutable files; Seed ${policy.seed.version} ${policy.seed.sha256} verified.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`Append-only release check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
