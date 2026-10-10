import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
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

const staged = run("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
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
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const options = process.platform === "win32" ? { shell: true } : {};
  // Fixed arguments only; filenames are never interpolated through a shell.
  run(executable, ["run", "format:check"], options);
  run(executable, ["run", "lint"], options);
}
