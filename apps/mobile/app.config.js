// app.config.js — dynamic Expo config layered on top of the static app.json.
//
// Why dynamic config: react-native-maps needs a Google Maps API key on
// Android (Info.plist / AndroidManifest meta-data). That key must never be
// committed to git, so it's injected here from a build-time environment
// variable (GOOGLE_MAPS_ANDROID_KEY, supplied via EAS secrets/env at build
// time) rather than hardcoded in app.json.
//
// Config-plugin approach note (react-native-maps@1.27.2): the classic
// `android.config.googleMaps.apiKey` field below is read by Expo's own
// bundled `@expo/config-plugins` (AndroidConfig.GoogleMapsApiKey), which is
// applied automatically to every managed/prebuild Expo project — it does
// NOT require an explicit entry in the `plugins` array. react-native-maps
// additionally ships its own config plugin (`react-native-maps/app.plugin.js`)
// for iOS Google Maps support (Podfile + AppDelegate GMSServices setup), but
// that's only needed if the iOS map provider is switched to Google Maps. This
// app renders Apple Maps by default on iOS (no key required there), so the
// react-native-maps plugin entry is not added in this phase.
//
// app.json remains the static source of truth for everything else (name,
// slug, scheme, owner, extra.eas.projectId, existing plugins, ios config,
// android.package/adaptiveIcon, etc.) — all of it is preserved by spreading
// appJson.expo below.
import appJson from "./app.json";

export default () => ({
  ...appJson.expo,
  android: {
    ...appJson.expo.android,
    config: {
      googleMaps: {
        apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY,
      },
    },
  },
});
