import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "win32") throw new Error("The packaged Windows smoke test must run on Windows.");

const root = path.resolve(import.meta.dir, "..");
const packageJson = await Bun.file(path.join(root, "package.json")).json() as { version?: unknown };
if (typeof packageJson.version !== "string" || !packageJson.version) {
  throw new Error("package.json does not contain an application version.");
}
const executable = path.resolve(process.argv[2] ?? path.join(root, "dist", `ValeCompanion-${packageJson.version}-windows-${process.arch}.exe`));
if (!existsSync(executable)) throw new Error(`Release package is missing: ${executable}`);

const dataDirectory = mkdtempSync(path.join(tmpdir(), "valecompanion-package-smoke-"));
await Bun.write(path.join(dataDirectory, "settings.json"), JSON.stringify({
  enabled: false,
  contributionEnabled: false,
  soundsEnabled: false,
}));
const legacyPortBlocker = Bun.serve({
  hostname: "127.0.0.1",
  port: 47_832,
  fetch: () => new Response("occupied by packaged smoke test"),
});

try {
  const application = Bun.spawn([executable, `--user-data-dir=${dataDirectory}`], {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      VALECOMPANION_DATA_DIR: dataDirectory,
      VALECOMPANION_SMOKE_TEST: "1",
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; application.kill(); }, 60_000);
  const exitCode = await application.exited.finally(() => clearTimeout(timeout));
  if (timedOut) throw new Error("Packaged application smoke test timed out.");
  if (exitCode !== 0) throw new Error(`Packaged application smoke test failed with exit code ${exitCode}.`);
  const log = await Bun.file(path.join(dataDirectory, "logs", "desktop.log")).text();
  if (!log.includes("Packaged smoke test passed")) {
    throw new Error(`Package exited without completing the renderer smoke test:\n${log.split("\n").slice(-20).join("\n")}`);
  }
  console.log("Release package launched its collector and renderer successfully.");
} finally {
  legacyPortBlocker.stop(true);
  rmSync(dataDirectory, { recursive: true, force: true });
}
