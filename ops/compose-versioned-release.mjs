import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  isProtectedTarget,
  isSafeRepoPath,
  verifySeedBytes,
} from "./append-only-check.mjs";

const omittedRoots = new Set([
  ".agents",
  ".cache",
  ".github",
  ".git",
  ".local",
  ".zioncore",
  "attached_assets",
  "generated-artifacts",
  "node_modules",
  "ops",
  "release-manifests",
  "versions",
]);
const releaseIdPattern = /^v[0-9]{4,}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function manifestPath(workspace, releaseId) {
  if (!releaseIdPattern.test(releaseId)) {
    throw new Error("Release ID must use the immutable vNNNN format.");
  }
  return path.join(workspace, "release-manifests", `${releaseId}.json`);
}

function resolveReleaseId(workspace, releaseId) {
  if (releaseId !== "latest") return releaseId;
  const candidates = readdirSync(path.join(workspace, "release-manifests"))
    .map((name) => name.match(/^(v[0-9]{4,})\.json$/)?.[1])
    .filter(Boolean)
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  if (!candidates.length) throw new Error("No immutable release manifest was found.");
  return candidates.at(-1);
}

function validateMapping(item, releaseId, workspace, policy) {
  if (
    !item ||
    typeof item !== "object" ||
    Object.keys(item).sort().join(",") !==
      "component,sha256,sourcePath,targetPath,version"
  ) {
    throw new Error(`${releaseId} contains a malformed version mapping.`);
  }
  const match = item.sourcePath?.match(
    /^versions\/(v[0-9]{4,})\/([A-Za-z0-9._-]+)\/(.+)$/,
  );
  if (
    !match ||
    match[1] !== item.version ||
    match[2] !== item.component ||
    !isSafeRepoPath(item.sourcePath) ||
    !isSafeRepoPath(item.targetPath) ||
    isProtectedTarget(item.targetPath, policy) ||
    !sha256Pattern.test(item.sha256 ?? "")
  ) {
    throw new Error(`${releaseId} contains an unsafe version mapping.`);
  }
  const sourcePath = path.resolve(workspace, item.sourcePath);
  const root = `${path.resolve(workspace)}${path.sep}`;
  if (!sourcePath.startsWith(root)) {
    throw new Error(`${releaseId} source escapes the release workspace.`);
  }
  const stat = lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${releaseId} source must be a regular file: ${item.sourcePath}`);
  }
  if (stat.size > policy.maximumSourceBytes) {
    throw new Error(`${item.sourcePath} exceeds the protected source-size limit.`);
  }
  const bytes = readFileSync(sourcePath);
  if (sha256(bytes) !== item.sha256) {
    throw new Error(`${item.sourcePath} does not match its manifest checksum.`);
  }
  return { bytes, sourcePath };
}

export function verifyManifestChain(workspace, selectedReleaseId, policy) {
  if (!releaseIdPattern.test(selectedReleaseId)) {
    throw new Error("Release ID must use the immutable vNNNN format.");
  }
  const seedBytes = readFileSync(path.join(workspace, policy.seed.path));
  if (!verifySeedBytes(seedBytes, policy.seed)) {
    throw new Error("The approved Genesis Seed bytes do not match the protected policy.");
  }

  const selectedNumber = Number(selectedReleaseId.slice(1));
  if (!Number.isSafeInteger(selectedNumber) || selectedNumber < 1) {
    throw new Error("Release ID is outside the supported range.");
  }
  let previousManifest;
  let previousBytes;
  let current;
  let activeBytes = 0;

  for (let number = 1; number <= selectedNumber; number++) {
    const releaseId = `v${String(number).padStart(4, "0")}`;
    const filePath = manifestPath(workspace, releaseId);
    const bytes = readFileSync(filePath);
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.releaseId !== releaseId ||
      manifest.parentReleaseId !== (previousManifest?.releaseId ?? null) ||
      (manifest.parentManifestSha256 ?? null) !==
        (previousBytes ? sha256(previousBytes) : null) ||
      manifest.baselineCommit !== policy.baselineCommit ||
      manifest.baselineTree !== policy.baselineTree ||
      manifest.seed?.path !== policy.seed.path ||
      manifest.seed?.version !== policy.seed.version ||
      manifest.seed?.bytes !== policy.seed.bytes ||
      manifest.seed?.sha256 !== policy.seed.sha256 ||
      !Array.isArray(manifest.activeVersions) ||
      manifest.activeVersions.length > 2048
    ) {
      throw new Error(`${releaseId} has an invalid parent or protected release identity.`);
    }

    const targets = new Map();
    activeBytes = 0;
    for (const item of manifest.activeVersions) {
      const checked = validateMapping(item, releaseId, workspace, policy);
      activeBytes += checked.bytes.length;
      if (activeBytes > policy.maximumActiveSourceBytes) {
        throw new Error(`${releaseId} exceeds the protected active-source size limit.`);
      }
      if (targets.has(item.targetPath)) {
        throw new Error(`${releaseId} maps multiple versions to ${item.targetPath}.`);
      }
      targets.set(item.targetPath, item);
    }
    if (previousManifest) {
      const nextTargets = targets;
      for (const item of previousManifest.activeVersions) {
        const replacement = nextTargets.get(item.targetPath);
        if (
          !replacement ||
          (replacement.sourcePath !== item.sourcePath &&
            replacement.version !== releaseId)
        ) {
          throw new Error(`${releaseId} removes or improperly replaces an active target.`);
        }
      }
    }
    previousManifest = manifest;
    previousBytes = bytes;
    current = { manifest, bytes };
  }
  return current;
}

function copyWorkspace(sourceRoot, outputRoot) {
  const outputPrefix = `${outputRoot}${path.sep}`;
  const visit = (sourcePath, destinationPath, relativePath) => {
    const resolvedSource = path.resolve(sourcePath);
    if (resolvedSource === outputRoot || resolvedSource.startsWith(outputPrefix)) return;
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      const linkText = readlinkSync(sourcePath);
      const resolvedLink = path.resolve(path.dirname(sourcePath), linkText);
      const sourcePrefix = `${sourceRoot}${path.sep}`;
      if (resolvedLink !== sourceRoot && !resolvedLink.startsWith(sourcePrefix)) {
        throw new Error(`Baseline symlink escapes the workspace: ${relativePath}`);
      }
      symlinkSync(linkText, destinationPath);
      return;
    }
    if (stat.isDirectory()) {
      mkdirSync(destinationPath, { recursive: true });
      for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
        const childRelative = relativePath
          ? `${relativePath}/${entry.name}`
          : entry.name;
        if (!relativePath && omittedRoots.has(entry.name)) continue;
        const childSource = path.join(sourcePath, entry.name);
        const childDestination = path.join(destinationPath, entry.name);
        visit(childSource, childDestination, childRelative);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported baseline entry: ${relativePath}`);
    cpSync(sourcePath, destinationPath);
  };
  visit(sourceRoot, outputRoot, "");
}

function writeOverlay(outputRoot, item, bytes) {
  const targetPath = path.resolve(outputRoot, item.targetPath);
  const outputPrefix = `${outputRoot}${path.sep}`;
  if (!targetPath.startsWith(outputPrefix)) {
    throw new Error(`Overlay target escapes the composed release: ${item.targetPath}`);
  }

  const relativeParts = path.relative(outputRoot, targetPath).split(path.sep);
  let parent = outputRoot;
  for (const part of relativeParts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
      throw new Error(`Overlay target traverses a symlink: ${item.targetPath}`);
    }
  }
  mkdirSync(path.dirname(targetPath), { recursive: true });
  if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
    throw new Error(`Overlay target is a symlink: ${item.targetPath}`);
  }
  writeFileSync(targetPath, bytes, { mode: 0o644 });
}

export function composeVersionedRelease({
  workspace,
  output,
  releaseId,
  sourceCommit,
}) {
  const sourceRoot = realpathSync(workspace);
  releaseId = resolveReleaseId(sourceRoot, releaseId);
  const outputRoot = path.resolve(output);
  const sourcePrefix = `${sourceRoot}${path.sep}`;
  if (
    outputRoot === sourceRoot ||
    outputRoot.startsWith(sourcePrefix) === false ||
    outputRoot.startsWith(`${sourceRoot}${path.sep}.git${path.sep}`)
  ) {
    throw new Error("Output must be a new directory inside the isolated build workspace.");
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) {
    throw new Error("--source-commit must be a full commit SHA.");
  }
  if (existsSync(outputRoot)) throw new Error("Output directory already exists.");

  const policy = readJson(path.join(sourceRoot, ".zioncore", "append-only-policy.json"));
  const { manifest, bytes: manifestBytes } = verifyManifestChain(
    sourceRoot,
    releaseId,
    policy,
  );

  mkdirSync(outputRoot, { recursive: false });
  try {
    copyWorkspace(sourceRoot, outputRoot);
    for (const item of manifest.activeVersions) {
      const { bytes: sourceBytes } = validateMapping(item, releaseId, sourceRoot, policy);
      writeOverlay(outputRoot, item, sourceBytes);
    }

    const releaseInfo = {
      schemaVersion: 1,
      releaseId,
      sourceCommit,
      manifestSha256: sha256(manifestBytes),
      baselineCommit: policy.baselineCommit,
      baselineTree: policy.baselineTree,
      seed: policy.seed,
      activeVersions: manifest.activeVersions,
    };
    writeFileSync(
      path.join(outputRoot, "zioncore-release.json"),
      `${JSON.stringify(releaseInfo, null, 2)}\n`,
      { mode: 0o644 },
    );
    return releaseInfo;
  } catch (error) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--manifest") args.releaseId = argv[++index];
    else if (argv[index] === "--output") args.output = argv[++index];
    else if (argv[index] === "--source-commit") args.sourceCommit = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!args.releaseId || !args.output || !args.sourceCommit) {
    throw new Error("Use --manifest latest|vNNNN --output PATH --source-commit FULL_SHA.");
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = composeVersionedRelease({
      workspace: process.cwd(),
      output: args.output,
      releaseId: args.releaseId,
      sourceCommit: args.sourceCommit,
    });
    console.log(
      `Composed ${result.releaseId} from ${result.sourceCommit}; manifest ${result.manifestSha256}; Seed ${result.seed.sha256}.`,
    );
  } catch (error) {
    console.error(`Release composition failed: ${error.message}`);
    process.exitCode = 1;
  }
}
