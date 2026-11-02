import { execFileSync } from "node:child_process";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

if (process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== "refs/heads/main") {
  throw new Error("Release tagging requires a push to main.");
}
const commit = process.env.GITHUB_SHA;
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("A full commit SHA is required.");

git("fetch", "origin", "main", "--tags");
git("merge-base", "--is-ancestor", commit, "origin/main");
const { version } = JSON.parse(git("show", `${commit}:package.json`));
const match =
  typeof version === "string" &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
    version,
  );
if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part))) {
  throw new Error("The package version must be a valid semantic version.");
}
const tag = `v${version}`;
if (git("tag", "--list", tag)) {
  const taggedCommit = git("rev-parse", `${tag}^{commit}`);
  git("merge-base", "--is-ancestor", taggedCommit, commit);
  const taggedPackage = JSON.parse(git("show", `${taggedCommit}:package.json`));
  if (taggedPackage.version !== version)
    throw new Error("The existing tag has a different package version.");
  console.log(`${tag} already exists on main; leaving it unchanged.`);
} else {
  git(
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "tag",
    "-a",
    tag,
    commit,
    "-m",
    `Release ${version}`,
  );
  git("push", "origin", `refs/tags/${tag}`);
  console.log(`Created ${tag} at ${commit}.`);
}
