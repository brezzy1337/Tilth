// babel.config.js — standard Expo SDK 56 babel setup.
//
// Note on react-native-reanimated v4 / react-native-worklets:
// babel-preset-expo@56.0.15 auto-detects an installed `react-native-worklets`
// package and injects `react-native-worklets/plugin` itself (see
// babel-preset-expo/build/configs/expo.js — "Automatically add worklets or
// reanimated plugin when package is installed"). Do NOT add the plugin again
// here — doing so would double-run the worklets Babel transform.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
