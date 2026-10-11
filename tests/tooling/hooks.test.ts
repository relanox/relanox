import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";

const folders: string[] = [];
const root = path.resolve(import.meta.dirname, "../..");

async function execute(directory: string, command: string, args: readonly string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, output });
    });
  });
}

function git(directory: string, args: readonly string[]) {
  return execute(directory, "git", args);
}

async function stage(directory: string) {
  expect((await git(directory, ["add", "."])).code).toBe(0);
}

afterEach(async () => {
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

it("enforces format, declaration spacing and type-aware lint on real commits without overwriting staged changes", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "relanox-hooks-"));
  folders.push(folder);
  expect((await git(folder, ["init", "--quiet"])).code).toBe(0);
  expect((await git(folder, ["config", "user.email", "hook-test@example.invalid"])).code).toBe(0);
  expect((await git(folder, ["config", "user.name", "Hook Test"])).code).toBe(0);
  expect((await git(folder, ["config", "core.hooksPath", ".githooks"])).code).toBe(0);
  for (const file of [
    ".githooks",
    ".oxlintrc.json",
    ".prettierrc.json",
    ".prettierignore",
    "scripts",
    "tsconfig.base.json",
  ]) {
    await cp(path.join(root, file), path.join(folder, file), { recursive: true });
  }
  await symlink(path.join(root, "node_modules"), path.join(folder, "node_modules"), "junction");
  await writeFile(path.join(folder, ".gitignore"), "node_modules/\n");
  await writeFile(
    path.join(folder, "tsconfig.json"),
    '{ "extends": "./tsconfig.base.json", "compilerOptions": {"types": ["node"]}, "include": ["*.ts", "scripts/**/*.mts"] }\n',
  );

  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    packageManager: string;
  };

  await writeFile(
    path.join(folder, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        packageManager: manifest.packageManager,
        scripts: { lint: manifest.scripts.lint, "format:check": manifest.scripts["format:check"] },
      },
      null,
      2,
    )}\n`,
  );
  expect(
    (
      await execute(folder, process.execPath, [
        path.join(root, "node_modules/prettier/bin/prettier.cjs"),
        "--write",
        ".",
      ])
    ).code,
  ).toBe(0);
  await writeFile(path.join(folder, "sample.ts"), "export const answer=42;\n");
  await stage(folder);
  const malformed = await git(folder, ["commit", "-m", "test: malformed format"]);
  expect(malformed.code).not.toBe(0);
  expect(malformed.output).toContain("sample.ts");
  expect(await readFile(path.join(folder, "sample.ts"), "utf8")).toBe("export const answer=42;\n");

  await writeFile(path.join(folder, "sample.ts"), "Promise.resolve(42);\n");
  await stage(folder);
  const floating = await git(folder, ["commit", "-m", "test: floating promise"]);
  expect(floating.code).not.toBe(0);
  expect(floating.output).toContain("no-floating-promises");

  await writeFile(path.join(folder, "sample.ts"), "export const answer = 42;\n");
  const partial = await git(folder, ["commit", "-m", "test: partial staged content"]);
  expect(partial.code).not.toBe(0);
  expect(partial.output).toContain("Partially staged files detected");
  expect((await git(folder, ["show", ":sample.ts"])).output).toBe("Promise.resolve(42);\n");

  const adjacentDeclarations = [
    "/** Input contract. */",
    "export interface Input {",
    "  value: number;",
    "}",
    "/** Return the input value. */",
    "export function read(input: Input): number {",
    "  return input.value;",
    "}",
    "// Output contract.",
    "export interface Output {",
    "  value: number;",
    "}",
    "/** Build an output value. */",
    "export function output(value: number): Output {",
    "  return { value };",
    "}",
    "",
  ].join("\n");

  await writeFile(path.join(folder, "sample.ts"), adjacentDeclarations);
  expect(
    (
      await execute(folder, process.execPath, [
        path.join(root, "node_modules/prettier/bin/prettier.cjs"),
        "--write",
        "sample.ts",
      ])
    ).code,
  ).toBe(0);
  const formattedDeclarations = await readFile(path.join(folder, "sample.ts"), "utf8");
  expect(formattedDeclarations).toBe(adjacentDeclarations);
  await stage(folder);
  const adjacent = await git(folder, ["commit", "-m", "test: adjacent declarations"]);
  expect(adjacent.code).not.toBe(0);
  expect(adjacent.output).toContain("padding-line-between-statements");
  expect(await readFile(path.join(folder, "sample.ts"), "utf8")).toBe(formattedDeclarations);
  expect(
    (
      await execute(folder, process.execPath, [
        path.join(root, "node_modules/oxlint/bin/oxlint"),
        "--fix",
        "sample.ts",
      ])
    ).code,
  ).toBe(0);
  expect(
    (
      await execute(folder, process.execPath, [
        path.join(root, "node_modules/prettier/bin/prettier.cjs"),
        "--write",
        "sample.ts",
      ])
    ).code,
  ).toBe(0);
  const spacedDeclarations = await readFile(path.join(folder, "sample.ts"), "utf8");
  expect(spacedDeclarations.replaceAll(/\s/gu, "")).toBe(
    adjacentDeclarations.replaceAll(/\s/gu, ""),
  );
  expect(spacedDeclarations).toContain("}\n\n/** Return the input value. */\nexport function read");
  expect(spacedDeclarations).toContain("}\n\n// Output contract.\nexport interface Output");
  expect(spacedDeclarations).toContain(
    "}\n\n/** Build an output value. */\nexport function output",
  );
  await stage(folder);
  const spaced = await git(folder, ["commit", "-m", "test: valid declaration spacing"]);
  if (spaced.code !== 0) {
    throw new Error(spaced.output);
  }
  expect((await git(folder, ["show", "HEAD:sample.ts"])).output).toBe(spacedDeclarations);

  await writeFile(path.join(folder, "sample.ts"), "export const answer = 42;\n");
  await stage(folder);
  const clean = await git(folder, ["commit", "-m", "test: valid style"]);
  if (clean.code !== 0) {
    throw new Error(clean.output);
  }
  expect(clean).toMatchObject({ code: 0 });
  expect((await git(folder, ["show", "HEAD:sample.ts"])).output).toBe(
    "export const answer = 42;\n",
  );

  expect((await git(folder, ["rm", "sample.ts"])).code).toBe(0);
  await writeFile(path.join(folder, "remaining.ts"), "export const answer=7;\n");
  const deletion = await git(folder, ["commit", "-m", "test: deletion with malformed checkout"]);
  expect(deletion.code).not.toBe(0);
  expect(deletion.output).toContain("remaining.ts");
  expect((await git(folder, ["diff", "--cached", "--name-status"])).output.trim()).toBe(
    "D\tsample.ts",
  );
  expect(await readFile(path.join(folder, "remaining.ts"), "utf8")).toBe(
    "export const answer=7;\n",
  );
  await writeFile(path.join(folder, "remaining.ts"), "export const answer = 7;\n");
  const cleanDeletion = await git(folder, ["commit", "-m", "test: valid deletion"]);
  expect(cleanDeletion).toMatchObject({ code: 0 });
  expect((await git(folder, ["ls-tree", "HEAD", "sample.ts"])).output).toBe("");
}, 60_000);
