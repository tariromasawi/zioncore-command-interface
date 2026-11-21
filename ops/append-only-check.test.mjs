import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedAddedPath,
  isProtectedTarget,
  isSafeRepoPath,
  parseNameStatus,
  validateChanges,
  verifySeedBytes,
} from "./append-only-check.mjs";
import { createHash } from "node:crypto";

const policy = {
  versionRoot: "versions",
  manifestRoot: "release-manifests",
  protectedTargets: [
    ".github/",
    ".zioncore/",
    "ops/",
    "Genesis seed.ts",
    "Dockerfile",
    "artifacts/api-server/src/command/store.ts",
    "artifacts/api-server/src/command/knowledgeArchive.ts",
    "artifacts/api-server/src/command/knowledgeVersions.ts",
    "artifacts/api-server/src/command/genesis.ts",
    "artifacts/api-server/src/command/dailyResearch.ts",
    "artifacts/api-server/src/command/knowledge.ts",
    "artifacts/api-server/src/command/cycle.ts",
    "artifacts/api-server/src/routes/command.ts",
    "artifacts/api-server/src/jobMain.ts",
    "artifacts/zioncore-command/src/pages/knowledge.tsx",
  ],
};

test("parses git name-status output without confusing paths and statuses", () => {
  assert.deepEqual(
    parseNameStatus("A\0versions/v0002/api-server/src/new.ts\0D\0src/old.ts\0"),
    [
      { status: "A", path: "versions/v0002/api-server/src/new.ts" },
      { status: "D", path: "src/old.ts" },
    ],
  );
});

test("only versioned source and sequential manifest paths can be added", () => {
  assert.equal(allowedAddedPath("versions/v0002/api-server/src/new.ts", policy), true);
  assert.equal(allowedAddedPath("release-manifests/v0002.json", policy), true);
  assert.equal(allowedAddedPath(".github/workflows/evil.yml", policy), false);
  assert.equal(allowedAddedPath("ops/deploy.sh", policy), false);
  assert.equal(allowedAddedPath("artifacts/api-server/src/new.ts", policy), false);
});

test("rejects path traversal, backslashes, non-normalized Unicode, and dot aliases", () => {
  for (const path of [
    "../versions/v0002/api-server/a.ts",
    "versions/v0002/api-server/../a.ts",
    "versions\\v0002\\api-server\\a.ts",
    "versions//v0002/api-server/a.ts",
    "versions/v0002/api-server/e\u0301.ts",
  ]) {
    assert.equal(isSafeRepoPath(path), false, path);
  }
});

test("release overlays cannot replace protected control targets or the Seed", () => {
  for (const path of [
    ".github/workflows/append-only-policy.yml",
    ".zioncore/append-only-policy.json",
    "ops/cloudbuild-research.yaml",
    "Genesis seed.ts",
    "Dockerfile",
    "artifacts/api-server/src/command/store.ts",
    "artifacts/api-server/src/command/knowledgeArchive.ts",
    "artifacts/api-server/src/command/knowledgeVersions.ts",
    "artifacts/api-server/src/command/genesis.ts",
    "artifacts/api-server/src/command/dailyResearch.ts",
    "artifacts/api-server/src/command/knowledge.ts",
    "artifacts/api-server/src/command/cycle.ts",
    "artifacts/api-server/src/routes/command.ts",
    "artifacts/api-server/src/jobMain.ts",
    "artifacts/zioncore-command/src/pages/knowledge.tsx",
  ]) {
    assert.equal(isProtectedTarget(path, policy), true, path);
  }
  assert.equal(isProtectedTarget("artifacts/api-server/src/command/engines.ts", policy), false);
});

test("source edits, deletions, renames, and copies are rejected", () => {
  const changes = parseNameStatus(
    "M\0artifacts/api-server/src/engine.ts\0D\0old.ts\0R100\0old-name.ts\0new-name.ts\0C100\0source.ts\0copy.ts\0",
  );
  const result = validateChanges(changes, [], policy);
  assert.equal(result.errors.length, 6);
  assert.match(result.errors[0], /Only additions are allowed; M/);
  assert.match(result.errors[1], /Only additions are allowed; D/);
  assert.match(result.errors[2], /Only additions are allowed; R/);
  assert.match(result.errors[4], /Only additions are allowed; C/);
  assert.deepEqual(result.additions, []);
});

test("new paths cannot shadow an existing path with different casing", () => {
  const result = validateChanges(
    [{ status: "A", path: "versions/v0002/api-server/src/New.ts" }],
    ["versions/v0002/api-server/src/new.ts"],
    policy,
  );
  assert.match(result.errors[0], /substitutes for an existing path/);
});

test("the exact Seed bytes are accepted and any edit is rejected", () => {
  const seed = Buffer.from("approved Genesis Seed\n");
  const identity = {
    bytes: seed.length,
    sha256: createHash("sha256").update(seed).digest("hex"),
  };
  assert.equal(verifySeedBytes(seed, identity), true);
  assert.equal(verifySeedBytes(Buffer.from("edited Genesis Seed\n"), identity), false);
});
