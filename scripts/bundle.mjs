import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--bin",
    "aside-cli",
    "--jobs",
    "4",
    "--manifest-path",
    "Cargo.toml",
    "--package",
    "aside-cli",
  ],
  { cwd: root, stdio: "inherit" },
);
execFileSync(
  path.join(root, "node_modules/.bin/tauri"),
  ["build", "--bundles", "app", "--no-sign"],
  { cwd: root, stdio: "inherit" },
);
const bundle = path.join(
  root,
  "src-tauri/target/release/bundle/macos/aside.app",
);
const command = path.join(bundle, "Contents/MacOS/aside-cli");
copyFileSync(path.join(root, "src-tauri/target/release/aside-cli"), command);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", command], {
  stdio: "inherit",
});
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", bundle], {
  stdio: "inherit",
});
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
  stdio: "inherit",
});
process.stdout.write(`${bundle}\n`);
