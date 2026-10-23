// Wrap the Neutralino mac binary (resources embedded) into a real
// dist/scratch.app: neu's --macos-bundle only renames the executable.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const config = JSON.parse(readFileSync("neutralino.config.json", "utf8"));
const arch = process.argv[2] ?? "universal";
const bin = [`dist/scratch/scratch-mac_${arch}`, `dist/scratch/scratch-mac_${arch}.app`].find(existsSync);
if (!bin) throw new Error(`no mac_${arch} binary in dist/scratch; run neu build --release --embed-resources first`);

const app = "dist/scratch.app";
rmSync(app, { recursive: true, force: true });
mkdirSync(`${app}/Contents/MacOS`, { recursive: true });
mkdirSync(`${app}/Contents/Resources`, { recursive: true });
cpSync(bin, `${app}/Contents/MacOS/scratch`);

writeFileSync(`${app}/Contents/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>scratch</string>
  <key>CFBundleDisplayName</key><string>scratch</string>
  <key>CFBundleIdentifier</key><string>${config.applicationId}</string>
  <key>CFBundleVersion</key><string>${config.version}</string>
  <key>CFBundleShortVersionString</key><string>${config.version}</string>
  <key>CFBundleExecutable</key><string>scratch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);

// embedding resources breaks the binary's signature; Apple silicon refuses
// to run unsigned code, so sign ad hoc
execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
console.log(`built ${app} (${arch})`);
