import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { composeVersionedRelease } from "./compose-versioned-release.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeWorkspace() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "zioncore-release-test-"));
  const seed = Buffer.from("approved Genesis Seed\n");
  const seedIdentity = {
    path: "Genesis seed.ts",
    version: "1.1.0",
    bytes: seed.length,
    sha256: sha256(seed),
  };
  const baseline = {
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  };
  const policy = {
    schemaVersion: 1,
    baselineCommit: baseline.commit,
    baselineTree: baseline.tree,
    seed: seedIdentity,
    versionRoot: "versions",
    manifestRoot: "release-manifests",
    maximumSourceBytes: 1024,
    maximumActiveSourceBytes: 4096,
    protectedTargets: [
      ".github/",
      ".zioncore/",
      "ops/",
      "release-manifests/",
      "versions/",
      "Genesis seed.ts",
      "zioncore-release.json",
    ],
  };
  mkdirSync(path.join(workspace, ".zioncore"), { recursive: true });
  mkdirSync(path.join(workspace, "release-manifests"), { recursive: true });
  mkdirSync(path.join(workspace, "artifacts", "api-server"), { recursive: true });
  mkdirSync(
    path.join(workspace, "versions", "v0002", "api-server", "src"),
    { recursive: true },
  );
  writeFileSync(path.join(workspace, ".zioncore", "append-only-policy.json"), JSON.stringify(policy));
  writeFileSync(path.join(workspace, "Genesis seed.ts"), seed);
  writeFileSync(
    path.join(workspace, "artifacts", "api-server", "method.txt"),
    "baseline method\n",
  );

  const first = {
    schemaVersion: 1,
    releaseId: "v0001",
    parentReleaseId: null,
    parentManifestSha256: null,
    baselineCommit: baseline.commit,
    baselineTree: baseline.tree,
    seed: seedIdentity,
    activeVersions: [],
  };
  const firstBytes = Buffer.from(`${JSON.stringify(first, null, 2)}\n`);
  writeFileSync(path.join(workspace, "release-manifests", "v0001.json"), firstBytes);

  const version = Buffer.from("verified reusable method\n");
  const sourcePath = "versions/v0002/api-server/src/method.txt";
  writeFileSync(path.join(workspace, sourcePath), version);
  const second = {
    schemaVersion: 1,
    releaseId: "v0002",
    parentReleaseId: "v0001",
    parentManifestSha256: sha256(firstBytes),
    baselineCommit: baseline.commit,
    baselineTree: baseline.tree,
    seed: seedIdentity,
    activeVersions: [
      {
        component: "api-server",
        version: "v0002",
        sourcePath,
        targetPath: "artifacts/api-server/method.txt",
        sha256: sha256(version),
      },
    ],
  };
  writeFileSync(
    path.join(workspace, "release-manifests", "v0002.json"),
    `${JSON.stringify(second, null, 2)}\n`,
  );
  return { workspace, sourcePath };
}

test("composes the selected additive version while preserving its source history", () => {
  const { workspace, sourcePath } = makeWorkspace();
  const output = path.join(workspace, "composed");
  try {
    const result = composeVersionedRelease({
      workspace,
      output,
      releaseId: "v0002",
      sourceCommit: "c".repeat(40),
    });
    assert.equal(
      readFileSync(path.join(output, "artifacts", "api-server", "method.txt"), "utf8"),
      "verified reusable method\n",
    );
    assert.equal(existsSync(path.join(workspace, sourcePath)), true);
    assert.equal(result.releaseId, "v0002");
    assert.equal(
      JSON.parse(readFileSync(path.join(output, "zioncore-release.json"), "utf8"))
        .sourceCommit,
      "c".repeat(40),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses a modified source version rather than silently composing it", () => {
  const { workspace, sourcePath } = makeWorkspace();
  const output = path.join(workspace, "composed");
  try {
    writeFileSync(path.join(workspace, sourcePath), "unverified replacement\n");
    assert.throws(
      () =>
        composeVersionedRelease({
          workspace,
          output,
          releaseId: "v0002",
          sourceCommit: "c".repeat(40),
        }),
      /does not match its manifest checksum/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

