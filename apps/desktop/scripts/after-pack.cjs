const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
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

  if (process.env.COD_ADHOC_SIGN === "true") {
    // Test builds downloaded by a browser still need a structurally valid
    // signature. This does not replace Developer ID signing or notarization,
    // but it prevents the post-pack Info.plist change from invalidating the
    // Electron bundle and being reported as a corrupt application.
    await execFileAsync("/usr/bin/codesign", [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
      "--options",
      "runtime",
      appPath,
    ]);
    await execFileAsync("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      appPath,
    ]);
  }
};
