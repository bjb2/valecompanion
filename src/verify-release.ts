import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// Use the same YAML parser as electron-builder, without adding a runtime dependency.
const require = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(require.resolve("electron-builder"));
const builderRequire = createRequire(electronBuilderRequire.resolve("app-builder-lib"));
const { load } = builderRequire("js-yaml") as { load(text: string): unknown };
const { version } = await Bun.file("package.json").json();
const [targetPlatform = process.platform, outputDirectory = "dist"] = process.argv.slice(2);
if (!["win32", "linux"].includes(targetPlatform)) throw new Error("Expected win32 or linux as the release platform.");
const windows = targetPlatform === "win32";
const prefix = `ValeCompanion-${version}`;
const names = windows
  ? [`${prefix}-windows-x64-setup.exe`, `${prefix}-windows-x64.exe`]
  : [`${prefix}-linux-x86_64.AppImage`, `${prefix}-linux-amd64.deb`, `${prefix}-linux-x86_64.rpm`];
for (const name of names) {
  if (!existsSync(path.join(outputDirectory, name))) throw new Error(`Missing release artifact: ${name}`);
}
const metadataFile = path.join(outputDirectory, windows ? "latest.yml" : "latest-linux.yml");
const metadata = load(await Bun.file(metadataFile).text()) as { version: string; files: { url: string; sha512: string }[] };
if (metadata.version !== version) throw new Error("Updater metadata does not match the package version.");
for (const file of metadata.files) {
  if (path.basename(file.url) !== file.url) throw new Error("Expected local release asset names in update metadata.");
  const bytes = await Bun.file(path.join(outputDirectory, file.url)).arrayBuffer();
  if (createHash("sha512").update(new Uint8Array(bytes)).digest("base64") !== file.sha512) throw new Error(`Update checksum mismatch: ${file.url}`);
}
for (const name of names.filter((name) => !windows || name.endsWith("-setup.exe"))) {
  if (!metadata.files.some((file) => file.url === name)) throw new Error(`Update metadata omits ${name}`);
}
console.log("Release artifacts and updater metadata verified.");
