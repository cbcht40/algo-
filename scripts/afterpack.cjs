// Ad-hoc code-sign the macOS app after packaging. electron-builder skips signing
// (identity: null, no Apple Developer ID), and adding our custom icon invalidates
// Electron's inherited signature — leaving a broken signature that makes a
// downloaded (quarantined) build show the hard "is damaged" error. A valid ad-hoc
// signature downgrades that to the bypassable "unidentified developer" prompt
// (right-click → Open), with no Apple account and no terminal step for the user.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  // When a real Developer ID identity is provided (CSC_LINK → notarized build),
  // electron-builder signs the app properly with hardened runtime. Re-signing
  // ad-hoc here would DESTROY that Developer ID signature → notarization invalid.
  // Only ad-hoc sign the free/unsigned build (no cert).
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[afterPack] Developer ID signing active → skip ad-hoc signing')
    return
  }
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  console.log(`[afterPack] ad-hoc signing ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
