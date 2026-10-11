import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import path from "node:path";
import process from "node:process";

function run(
  command: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    process.stderr.write(`Pre-commit failed: ${command}\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

const staged = run("git", ["diff", "--cached", "--name-only", "-z"], {
  stdio: "pipe",
})
  .split("\0")
  .filter(Boolean);
if (staged.length > 0) {
  // Never rewrite or auto-stage a developer's partially staged changes.
  const unstaged = new Set(
    run("git", ["diff", "--name-only", "-z"], {
      stdio: "pipe",
    })
      .split("\0")
      .filter(Boolean),
  );
  if (staged.some((file) => unstaged.has(file))) {
    process.stderr.write(
      "Partially staged files detected. Stage the reviewed formatting changes or restore the unstaged part before committing.\n",
    );
    process.exit(1);
  }
  // Invoke the pinned local CLIs directly, without platform shell interpolation.
  run(process.execPath, [path.resolve("node_modules/oxfmt/bin/oxfmt"), "--check", "."]);
  run(process.execPath, [
    path.resolve("node_modules/oxlint/bin/oxlint"),
    "--deny-warnings",
    "--report-unused-disable-directives-severity",
    "error",
    ".",
  ]);
}
