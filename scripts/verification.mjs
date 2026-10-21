import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "work/verification");
const application = path.join(directory, "ink and butter Verification.app");
const executable = path.join(application, "Contents/MacOS/inknb-desktop");
const processes = execFileSync("/bin/ps", ["-ax", "-o", "comm="], {
  encoding: "utf8",
});
if (processes.split("\n").some((process) => process.trim() === executable))
  throw Error("Quit the verification instance before rebuilding it.");
execFileSync(process.execPath, [path.join(root, "scripts/bundle.mjs")], {
  cwd: root,
  stdio: "inherit",
});
mkdirSync(directory, { recursive: true });
rmSync(application, { recursive: true, force: true });
cpSync(
  path.join(root, "src-tauri/target/release/bundle/macos/ink and butter.app"),
  application,
  { recursive: true },
);
const properties = path.join(application, "Contents/Info.plist");
for (const [key, value] of Object.entries({
  CFBundleIdentifier: "io.github.limiteinductive.aside.profiles.verification",
  CFBundleName: "ink and butter Verification",
  CFBundleDisplayName: "ink and butter Verification",
  CFBundleExecutable: "inknb-verification",
}))
  execFileSync("/usr/bin/plutil", [
    "-replace",
    key,
    "-string",
    value,
    properties,
  ]);
execFileSync("/usr/bin/plutil", [
  "-remove",
  "CFBundleDocumentTypes",
  properties,
]);
const launcher = path.join(application, "Contents/MacOS/inknb-verification");
writeFileSync(
  launcher,
  '#!/bin/sh\nexec "$(dirname "$0")/inknb-desktop" --profile=verification "$@"\n',
);
chmodSync(launcher, 0o755);
for (const binary of [
  executable,
  path.join(application, "Contents/MacOS/inknb"),
])
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", binary]);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", application]);
execFileSync("/usr/bin/codesign", [
  "--verify",
  "--deep",
  "--strict",
  application,
]);
process.stdout.write(`${application}\n`);
