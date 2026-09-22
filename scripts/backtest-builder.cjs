// Separate Backtesting application. Its identity and icon must never replace the
// user's installed order copier; the two apps can run at the same time.
const { build: base } = require('../package.json')

module.exports = {
  ...base,
  appId: 'com.lettradejournal.backtesting',
  productName: 'Let-Trade Backtesting',
  artifactName: 'Let-Trade-Backtesting-${version}-${arch}.${ext}',
  extraMetadata: { backtestStandalone: true },
  files: [...base.files, 'assets/backtesting-icon.png'],
  directories: { output: 'release-backtest-standalone' },
  mac: {
    ...base.mac,
    icon: 'assets/backtesting-icon.png',
    target: ['dir'],
    // The local build is usable on this Mac. Public distribution waits for a
    // valid Apple notarization profile; opt in explicitly when one is present.
    notarize: process.env.BACKTEST_NOTARIZE === '1',
  },
  win: { ...base.win, icon: 'assets/backtesting-icon.png' },
  protocols: [{ name: 'Let-Trade Backtesting', schemes: ['lettrade'] }],
}
