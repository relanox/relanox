import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { deadline } from "../src/deadline.js";
import { noopObservability } from "@relanox/sdk";
import type { RelanoxConfig } from "@relanox/sdk";
import { sqliteStoragePlugin } from "@relanox/storage-sqlite";

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "relanox-cli-"));
  const filename = join(directory, "relay.sqlite");
  const configPath = join(directory, "relay.json");

  const relay: RelanoxConfig = {
    accounts: [],
    endpoints: [],
    bindings: [],
    storage: { plugin: "sqlite", config: { filename } },
    observability: { plugin: "none", config: {} },
  };

  const config = {
    relay,
    server: { port: 0, managementPort: 0, workerIntervalMs: 20, workerStaleMs: 1000 },
  };

  const save = async (input: unknown = config) => writeFile(configPath, JSON.stringify(input));
  await save();
  return { directory, filename, configPath, config, save };
}

export function cli(path: string, args: readonly string[]) {
  const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args, "--config", path], {
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export function storage(filename: string) {
  return sqliteStoragePlugin.setup(
    sqliteStoragePlugin.validateConfig({ filename }),
    noopObservability,
  );
}

export async function runCli(path: string) {
  const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "run", "--config", path], { windowsHide: true });

  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });

  const started = new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\n")) {
        try {
          const value = z
            .object({ event: z.literal("started"), managementUrl: z.url() })
            .parse(JSON.parse(output.split("\n")[0] ?? ""));

          resolve(value.managementUrl);
        } catch (error) {
          reject(error instanceof Error ? error : new Error("cli_invalid_startup_output"));
        }
      }
    });
    child.once("error", reject);
    child.once("close", () => {
      reject(new Error("cli_exited_before_startup"));
    });
  });

  async function stop() {
    child.kill();
    await deadline(closed, 5000);
  }

  try {
    const managementUrl = await deadline(started, 5000);
    return { managementUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
