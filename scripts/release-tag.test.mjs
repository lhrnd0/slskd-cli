import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./release-tag.mjs", import.meta.url));
const tag = "v0.2.0-beta.1";

function fixture(t, version = "0.2.0-beta.1") {
  const directory = mkdtempSync(join(tmpdir(), "slskd-release-tag-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  const checkout = join(directory, "checkout");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: checkout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--bare", remote);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("config", "core.hooksPath", join(directory, "no-hooks"));
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ version }));
  git("add", "package.json");
  git("commit", "-m", "Initial version");
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");
  const commit = git("rev-parse", "HEAD");
  const run = (env = {}) =>
    spawnSync(process.execPath, [script], {
      cwd: checkout,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: git("rev-parse", "HEAD"),
        ...env,
      },
      encoding: "utf8",
      timeout: 10000,
    });
  const remoteTag = () => git("ls-remote", "origin", `refs/tags/${tag}^{}`);
  return { git, run, remoteTag, commit, checkout };
}

test("release tag creates an annotated remote tag at the verified main commit", (t) => {
  const host = fixture(t);
  const result = host.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(host.git("cat-file", "-t", `refs/tags/${tag}`), "tag");
  assert.equal(host.remoteTag().split("\t")[0], host.commit);
});

test("release tag preserves an existing tag on an earlier main commit", (t) => {
  const host = fixture(t);
  assert.equal(host.run().status, 0);
  const original = host.git("rev-parse", `refs/tags/${tag}`);
  host.git("commit", "--allow-empty", "-m", "Documentation update");
  host.git("push", "origin", "main");
  const result = host.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already exists/);
  assert.equal(host.git("rev-parse", `refs/tags/${tag}`), original);
  assert.equal(host.remoteTag().split("\t")[0], host.commit);
});

test("release tag rejects PR events without creating a remote tag", (t) => {
  const host = fixture(t);
  const result = host.run({ GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a push to main/);
  assert.equal(host.remoteTag(), "");
});

test("release tag rejects a target outside main without creating a remote tag", (t) => {
  const host = fixture(t);
  host.git("checkout", "-b", "unmerged");
  host.git("commit", "--allow-empty", "-m", "Unmerged change");
  const result = host.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /merge-base --is-ancestor/);
  assert.equal(host.remoteTag(), "");
});

test("release tag refuses an existing tag outside main", (t) => {
  const host = fixture(t);
  host.git("checkout", "-b", "unmerged");
  host.git("commit", "--allow-empty", "-m", "Unmerged change");
  host.git("tag", "-a", tag, "-m", "Conflicting tag");
  host.git("push", "origin", `refs/tags/${tag}`);
  const original = host.remoteTag();
  host.git("checkout", "main");
  const result = host.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /merge-base --is-ancestor/);
  assert.equal(host.remoteTag(), original);
});

test("release tag rejects an invalid package version", (t) => {
  const host = fixture(t, "not-a-version");
  const result = host.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /valid semantic version/);
  assert.equal(host.git("ls-remote", "--tags", "origin"), "");
});
