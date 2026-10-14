// RevenueCat / Google Play Billing: the purchasing activity must use launchMode "standard" or "singleTop".
// With "singleTask", a purchase can be cancelled when the app is backgrounded mid-payment (e.g. a bank's 3-D Secure step).
// Applied at prebuild time, since android/ is generated (never edited by hand).
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withSingleTopActivity(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    const main = app?.activity?.find((a) => a.$['android:name'] === '.MainActivity');
    if (main) main.$['android:launchMode'] = 'singleTop';
    return cfg;
  });
};
