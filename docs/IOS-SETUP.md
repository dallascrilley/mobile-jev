# Local iOS device service

Date: 2026-10-06
Status: Installed and checked on DeviPhone11; Kami's iPad setup is staged and blocked by its passcode lock
Related: [acceptance](learnings/ios-agent-acceptance-2026-10-06.md), [Android setup](LOCAL-SETUP.md)

Select `MOBILE_DEVICE_BACKEND=ios` explicitly. The adapter supports physical iPhones and iPads through Appium's signed WebDriverAgent (WDA), Xcode `devicectl`, and an exact-UDID `iproxy` connection. It requires no Mobilerun account, key, or subscription. Hosted Jev is the default decision provider; Rizzo is an explicit local option. Device permissions, pairing, passcode entry, and Developer Mode retain Apple's controls.

## Build the runner

Requirements: macOS, Xcode with the matching device SDK, an existing Apple development signing identity/profile that includes the device, Node 22.16+, and libimobiledevice's `iproxy`. Both paired devices must have Developer Mode enabled. Keep runner source and build products outside Git. The tested official WDA source revision is `381e75ce6ad1afb97b46cc3aa72e758193af1353` (12.2.0).

```sh
git clone https://github.com/appium/WebDriverAgent.git "$wda_source"
git -C "$wda_source" checkout 381e75ce6ad1afb97b46cc3aa72e758193af1353
cd "$wda_source"
xcodebuild build-for-testing \
  -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
  -destination 'generic/platform=iOS' -derivedDataPath "$wda_build" \
  DEVELOPMENT_TEAM="$signing_team" CODE_SIGN_STYLE=Automatic \
  'CODE_SIGN_IDENTITY=Apple Development' IPHONEOS_DEPLOYMENT_TARGET=15.0 \
  PRODUCT_BUNDLE_IDENTIFIER=com.dallascrilley.agentdeviceios.WebDriverAgentRunner
```

Set those three shell variables to task-owned source/build directories and the existing signing team. This route used a cached, valid development profile; it did not copy private credentials to a device. See the official [real-device preparation](https://appium.github.io/appium-xcuitest-driver/latest/preparation/real-device-config/) and [running WDA](https://github.com/appium/appium-xcuitest-driver/blob/master/docs/guides/attach-to-running-wda.md) guidance. Updating Xcode, the device OS, signing profiles, or WDA requires new preflight proof.

## One private config per device

Create an owner-only JSON config outside Git (`chmod 600`) containing the following flat string values:

```json
{
  "IOS_DEVICE_UDID": "exact-physical-udid",
  "IOS_DEVICE_NAME": "exact-devicectl-name",
  "IOS_WDA_URL": "http://127.0.0.1:18100",
  "IOS_WDA_BUILD_DIR": "/absolute/build/Build/Products",
  "IOS_WDA_SOURCE_REVISION": "381e75ce6ad1afb97b46cc3aa72e758193af1353",
  "IOS_WDA_BINDING_FILE": "/absolute/private/iphone-binding.json",
  "IOS_WDA_EXPECTED_NAME": "iPhone",
  "IOS_NODE_BIN": "/absolute/path/to/node",
  "DEVICE_SERVICE_PORT": "3042",
  "DECISION_BACKEND": "jev",
  "TYPESAFE_MODEL": "jev-1.13.0"
}
```

Use separate ports, UDIDs, bindings and config files for each device. The staged iPad uses WDA 18101 and service 3043; its WDA name is expected to be `iPad` and must be verified on first connection. Android remains on service 3041. A config cannot contain credentials. The existing `with-typesafe-key.mjs` wrapper obtains the approved TypeSafe key at runtime from the server's ignored configuration and passes it only to the decision service. WDA and `iproxy` receive no key.

First enrollment learns WDA's vendor UUID only from the supervisor's exclusively owned exact-UDID proxy, then saves it in an owner-only file. Later starts check that pin. `IOS_EXPECTED_VENDOR_UUID` can supply an existing verified pin. This value is not interchangeable with the Apple UDID. Binding ownership, endpoint, live runner/proxy PIDs, source revision, WDA identity and `devicectl` transport all gate adapter operations. The iPhone's live config includes its verified vendor pin.

```sh
node scripts/install-ios-service.mjs --config /absolute/private/iphone-config.json
node scripts/install-ios-service.mjs --config /absolute/private/iphone-config.json --install
IOS_RUNTIME_CONFIG=/absolute/private/iphone-config.json node scripts/ios-runtime.mjs --verify
```

The first command is a read-only installation check; `--install` writes and loads the per-device user LaunchAgent. It preserves a different existing plist or live binding and refuses conflicting peer ports/identities. Supply `--path` or `--node` when local runtime paths differ. The installer waits for service health. The supervisor owns the proxy, runner and service, derives a device-specific `.xctestrun`, and stops all its children after an owned process fails. launchd restarts the job. A locked device exits as blocked without any input. Do not start a second runner on the same device.

## CLI, studio and Raycast

For direct CLI or studio use, export the config's iOS values, `MOBILE_DEVICE_BACKEND=ios`, and `AGENT_DEVICE_IDENTITY` equal to `IOS_DEVICE_UDID`. Do not reuse Android's identity. Leave `IOS_WDA_SESSION_ID` unset to read the currently owned WDA session, or supply its exact current ID. For an iPhone studio use `DEVICE_SERVICE_PORT=3042` and `STUDIO_PORT=3044`, then start through `node scripts/with-typesafe-key.mjs pnpm start`. Direct CLI commands share the same UDID lock as the service, studio workers and Raycast goals.

The adapter exposes app inventory and launch, foreground and accessibility state, PNG screenshots, fresh-target taps, swipes, exact Unicode/multiline text replacement and clearing, enter/delete, and Home. It rejects generic Back/Recent Apps/Tab; use a freshly observed in-app Back control. Native switches resolve one exact WDA target because a SwiftUI row's center can miss its control. A transport acknowledgment remains unverified. Exact field readback verifies text; Home/app launch verifies foreground. An uncertain mutation is never replayed.

The service exposes the same typed routes as Android and no unrestricted shell. iOS `/recover` verifies connection readiness under the shared lock; the supervisor owns process recovery. A physically unplugged, locked, or unpaired device can still require reconnection or human unlocking. Goal execution survives a Raycast view closing; service restart loses in-memory run history. Status and stop avoid the device lock held by a running goal.

The standalone `agent-device-ios` Raycast extension selects either the iPhone service or the iPad service, keeps identity/run caches separate, and shows service-reported runtime paths. Its scoped Agent reference attaches only its iOS tools. No Raycast AI account or subscription was created. The fixture and service proof do not establish activation of a Raycast AI Agent.
