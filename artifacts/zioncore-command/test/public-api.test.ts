import { strict as assert } from "node:assert";
import { test } from "node:test";
import { safeHttpsUrl, safeInternalPath } from "../src/lib/public-api";

test("evidence permits known internal routes without admitting redirects or schemes", () => {
  for (const path of ["/", "/continuity", "/knowledge", "/runs/run-123", "/engines", "/engines/example-engine"]) {
    assert.equal(safeInternalPath(path), path);
  }
  for (const value of ["javascript:alert(1)", "//evil.example", "/\\evil.example", "/%2f%2fevil.example", "/continuity?next=https://evil.example", "/../continuity", "https://example.org"]) {
    assert.equal(safeInternalPath(value), undefined);
  }
});

test("external evidence and suggestion resources require credential-free HTTPS", () => {
  assert.equal(safeHttpsUrl("https://example.org/path"), "https://example.org/path");
  const withCredentials = new URL("https://example.org");
  withCredentials.username = "user";
  withCredentials.password = "pass";
  for (const value of ["/continuity", "http://example.org", "javascript:alert(1)", "//evil.example", withCredentials.href]) {
    assert.equal(safeHttpsUrl(value), undefined);
  }
});
