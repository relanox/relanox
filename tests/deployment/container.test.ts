import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";

const execute = promisify(execFile);
const image = process.env.RELANOX_TEST_CONTAINER_IMAGE;
async function docker(...args: string[]): Promise<string> {
  const result = await execute("docker", args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
async function waitHealthy(name: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await docker("inspect", "--format", "{{.State.Health.Status}}", name);
    if (status === "healthy") {
      return;
    }
    if (status === "unhealthy") {
      throw new Error("container_unhealthy");
    }
    await delay(1000);
  }
  throw new Error("container_readiness_timeout");
}

test.skipIf(!image)(
  "production image initializes automatically and restarts with persistent SQLite",
  async () => {
    if (!image) {
      throw new Error("container_image_required");
    }
    const name = `relanox-test-${randomUUID()}`;
    const volume = `${name}-data`;
    const config = resolve("deploy/empty.example.json");
    const mounts = [
      "--mount",
      `type=volume,source=${volume},target=/data`,
      "--mount",
      `type=bind,source=${config},target=/config/relanox.json,readonly`,
    ];
    await docker("volume", "create", volume);
    try {
      await docker(
        "run",
        "--detach",
        "--name",
        name,
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        ...mounts,
        image,
      );
      await waitHealthy(name);
      expect(await docker("exec", name, "node", "-p", "process.getuid()")).toBe("1000");
      expect(await docker("inspect", "--format", "{{.RestartCount}}", name)).toBe("0");
      await docker("restart", "--time", "20", name);
      await waitHealthy(name);
      expect(
        await docker(
          "exec",
          name,
          "node",
          "--input-type=module",
          "-e",
          "const r = await fetch('http://127.0.0.1:8788/health/ready'); process.stdout.write(String(r.status))",
        ),
      ).toBe("200");
    } finally {
      await docker("rm", "--force", name).catch(() => {});
      await docker("volume", "rm", volume);
    }
  },
  180_000,
);
