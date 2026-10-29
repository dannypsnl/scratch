// Wrap the Neutralino mac binary (resources embedded) into a real
// dist/mac_<arch>/scratch.app: neu's --macos-bundle only renames the
// executable. One app per architecture: a universal binary holds two
// executables, each with its own copy of the embedded resources. The MCP
// server (scripts/bundle-mcp.mjs) goes in Contents/Resources.
//   node scripts/bundle-mac.mjs arm64|x64
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const config = JSON.parse(readFileSync("neutralino.config.json", "utf8"));
const arch = process.argv[2] ?? "arm64";
const bin = [`dist/scratch/scratch-mac_${arch}`, `dist/scratch/scratch-mac_${arch}.app`].find(existsSync);
if (!bin) throw new Error(`no mac_${arch} binary in dist/scratch; run neu build --release --embed-resources first`);
const mcp = "dist/mcp/scratch-mcp.mjs";
if (!existsSync(mcp)) throw new Error(`no ${mcp}; run node scripts/bundle-mcp.mjs first`);

const app = `dist/mac_${arch}/scratch.app`;
rmSync(app, { recursive: true, force: true });
mkdirSync(`${app}/Contents/MacOS`, { recursive: true });
mkdirSync(`${app}/Contents/Resources`, { recursive: true });
cpSync(bin, `${app}/Contents/MacOS/scratch`);
cpSync("icon/scratch.icns", `${app}/Contents/Resources/scratch.icns`);
cpSync(mcp, `${app}/Contents/Resources/scratch-mcp.mjs`);

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
  <key>CFBundleIconFile</key><string>scratch</string>
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
