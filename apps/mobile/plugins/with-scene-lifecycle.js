const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

/**
 * iOS 27 traps at launch unless the app adopts the UIScene life cycle. Expo ships
 * ExpoAppSceneDelegate but the SDK 57 template does not wire it yet; this plugin does,
 * and is a no-op once the template catches up.
 */
const withSceneManifest = (config) =>
  withInfoPlist(config, (mod) => {
    mod.modResults.UIApplicationSceneManifest ??= {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "EXExpoAppSceneDelegate",
          },
        ],
      },
    };
    return mod;
  });

const withSceneAppDelegate = (config) =>
  withAppDelegate(config, (mod) => {
    let src = mod.modResults.contents;
    if (src.includes("ExpoReactNativeFactoryProvider")) return mod;
    src = src.replace(
      "class AppDelegate: ExpoAppDelegate {",
      'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {\n  var reactNativeFactoryModuleName: String { "main" }',
    );
    // The scene delegate owns the window and starts React Native into it.
    src = src.replace(
      /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/,
      "",
    );
    mod.modResults.contents = src;
    return mod;
  });

module.exports = (config) => withSceneAppDelegate(withSceneManifest(config));
