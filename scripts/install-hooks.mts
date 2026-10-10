import { spawnSync } from "node:child_process";
import process from "node:process";

const repository = spawnSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
if (repository.status === 0) {
  const configured = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
    stdio: "inherit",
  });
  if (configured.status !== 0) {
    process.exit(configured.status ?? 1);
  }
}
