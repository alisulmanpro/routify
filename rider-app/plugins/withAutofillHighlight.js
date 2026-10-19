// Android paints autofilled text boxes with its own yellow highlight, drawn over the box. On the app's dark inputs
// with white text it hid what was typed. This swaps it for a faint orange tint and outline, so autofill still works
// and the text stays readable. Applied at prebuild time (android/ is generated); Expo Go keeps the system default.
const fs = require('fs');
const path = require('path');
const { withAndroidStyles, withDangerousMod } = require('expo/config-plugins');

const DRAWABLE = 'autofill_highlight';
const SHAPE = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
  <solid android:color="#1FFFAA32" />
  <stroke android:width="1dp" android:color="#99FFAA32" />
  <corners android:radius="8dp" />
</shape>
`;

module.exports = function withAutofillHighlight(config) {
  config = withDangerousMod(config, ['android', async (cfg) => {
    const dir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'drawable');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${DRAWABLE}.xml`), SHAPE);
    return cfg;
  }]);
  return withAndroidStyles(config, (cfg) => {
    const theme = cfg.modResults.resources.style?.find((s) => s.$.name === 'AppTheme');
    if (theme) {
      theme.item = (theme.item || []).filter((i) => i.$.name !== 'android:autofilledHighlight');
      theme.item.push({ $: { name: 'android:autofilledHighlight' }, _: `@drawable/${DRAWABLE}` });
    }
    return cfg;
  });
};
