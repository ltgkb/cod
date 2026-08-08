const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const infoPlist = path.join(context.appOutDir, `${appName}.app`, "Contents", "Info.plist");
  const plistBuddy = "/usr/libexec/PlistBuddy";

  // electron-builder currently forces this key to true after merging extendInfo.
  // Override it before signing so the shipped app only permits the explicit
  // loopback exceptions used by the local Goose sidecar.
  await execFileAsync(plistBuddy, [
    "-c",
    "Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false",
    infoPlist,
  ]);

  const { stdout } = await execFileAsync(plistBuddy, [
    "-c",
    "Print :NSAppTransportSecurity:NSAllowsArbitraryLoads",
    infoPlist,
  ]);
  if (stdout.trim() !== "false") {
    throw new Error(`Failed to harden App Transport Security in ${infoPlist}`);
  }
};
