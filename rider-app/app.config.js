// Extends app.json. The Google Maps key comes from the environment (.env locally, EAS environment
// variables for cloud builds) so it is never committed.
module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins || []),
    ['react-native-maps', {
      androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY,
      iosGoogleMapsApiKey: process.env.GOOGLE_MAPS_IOS_API_KEY,
    }],
  ],
});
