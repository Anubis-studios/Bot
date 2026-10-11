#!/usr/bin/env node
/**
 * The registry snapshot and its check (spec 01 §5.4).
 *
 *   node scripts/shadcn-registry-snapshot.mjs --record
 *     Dry-runs the §5.2 `add` through the proxy in record mode, storing every
 *     response under shadcn-registry/<today>/ with a manifest. (Run
 *     shadcn-init.mjs --snapshot <same dir> first, so init's fetches are
 *     in it too.) Commit the directory on its own.
 *
 *   node scripts/shadcn-registry-snapshot.mjs --check        (check:ui-registry)
 *     Offline. Copies this package's registry inputs to a temp dir, replays
 *     the `add` from the newest snapshot there, formats the output with the
 *     repo's oxfmt config, applies ui-local.patch and diffs the result
 *     against the committed ui/.
 *
 *   node scripts/shadcn-registry-snapshot.mjs --local-patch
 *     Rewrites ui-local.patch as the committed ui/ against the replay. The
 *     patch is every edit made to registry output, reviewed as a diff: an
 *     edit to ui/ that is not in it fails the check.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registryContent } from "./registry-content.mjs";
import { addFromSnapshot, INITIAL_ITEMS, latestSnapshot } from "./shadcn.mjs";

const desktop = join(import.meta.dirname, "../../web");
const repo = join(desktop, "../..");

const record = async () => {
  const snapshot = join(
    desktop,
    "../desktop/shadcn-registry",
    new Date().toISOString().slice(0, 10)
  );
  await addFromSnapshot({
    items: INITIAL_ITEMS,
    snapshot,
    record: true,
    dryRun: true,
  });
  console.log(`recorded ${snapshot}`);
};

const LOCAL_PATCH = join(desktop, "../desktop/shadcn-registry/ui-local.patch");

/** The snapshot's `add` replayed and formatted in `temp`, as `temp/src/ui`. */
const replay = async (temp) => {
  for (const file of ["package.json", "components.json", "tsconfig.json"])
    cpSync(join(desktop, file), join(temp, file));
  mkdirSync(join(temp, "src"), { recursive: true });
  for (const dir of ["styles", "lib"])
    cpSync(join(desktop, "src", dir), join(temp, "src", dir), {
      recursive: true,
    });
  // The CLI resolves packages from node_modules next to package.json.
  execFileSync("ln", [
    "-s",
    join(repo, "node_modules"),
    join(temp, "node_modules"),
  ]);

  await addFromSnapshot({
    cwd: temp,
    items: INITIAL_ITEMS,
    snapshot: latestSnapshot(),
  });
  execFileSync(
    join(repo, "node_modules/.bin/oxfmt"),
    ["--config", join(repo, "oxfmt.config.ts"), join(temp, "src/ui")],
    {
      cwd: repo,
      stdio: "inherit",
    }
  );
};

const localPatch = async () => {
  const temp = mkdtempSync(join(tmpdir(), "ui-registry-"));
  try {
    await replay(temp);
    cpSync(join(desktop, "src/ui"), join(temp, "committed/src/ui"), {
      recursive: true,
    });
    // Exit 1 means the trees differ, which is the point.
    const diff = spawnSync(
      "git",
      ["diff", "--no-index", "--no-prefix", "src/ui", "committed/src/ui"],
      { cwd: temp, encoding: "utf8" }
    );
    if (diff.status !== 0 && diff.status !== 1) throw new Error(diff.stderr);
    writeFileSync(
      LOCAL_PATCH,
      diff.stdout.replaceAll("committed/src/ui/", "src/ui/")
    );
    console.log(`wrote ${LOCAL_PATCH}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

const check = async () => {
  const temp = mkdtempSync(join(tmpdir(), "ui-registry-"));
  try {
    await replay(temp);
    if (existsSync(LOCAL_PATCH))
      execFileSync("git", ["apply", "-p0", LOCAL_PATCH], {
        cwd: temp,
        stdio: "inherit",
      });

    const committed = join(desktop, "src/ui");
    const replayed = join(temp, "src/ui");
    const names = new Set([
      ...readdirSync(committed),
      ...readdirSync(replayed),
    ]);
    const { rsc } = JSON.parse(
      readFileSync(join(desktop, "components.json"), "utf8")
    );
    const diffs = [...names].filter((name) => {
      try {
        return (
          registryContent(readFileSync(join(committed, name), "utf8"), rsc) !==
          registryContent(readFileSync(join(replayed, name), "utf8"), rsc)
        );
      } catch {
        return true;
      }
    });
    if (diffs.length > 0) {
      console.error(
        `check:ui-registry: ui/ differs from the snapshot: ${diffs.join(", ")}`
      );
      process.exit(1);
    }
    console.log(`check:ui-registry: ${names.size} files match the snapshot`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

const mode = process.argv[2];
if (mode === "--record") await record();
else if (mode === "--check") await check();
else if (mode === "--local-patch") await localPatch();
else {
  console.error(
    "usage: shadcn-registry-snapshot.mjs --record | --check | --local-patch"
  );
  process.exit(1);
}
