# Agent Device Fixture (iOS / iPadOS)

A small synthetic SwiftUI app for acceptance testing of device-control agents.
It is not the system Calculator and not a realistic task. It stores nothing,
uses no network, contains no secrets, and changes no system settings.

- Product name: Agent Device Fixture
- Bundle ID: `com.dallascrilley.agentdeviceios.fixture`
- Targets: iPhone and iPad (`TARGETED_DEVICE_FAMILY = 1,2`), iOS 17.0 or later
- Signing: not in source. Pass it on the `xcodebuild` command line.

## Build

The Xcode project is generated and is not committed. Generate it outside the
source tree if you want a clean checkout:

```sh
xcodegen generate --spec fixtures/ios-agent/project.yml \
  --project ~/.local/share/agent-device-ios/fixture

xcodebuild \
  -project ~/.local/share/agent-device-ios/fixture/AgentDeviceFixture.xcodeproj \
  -scheme AgentDeviceFixture \
  -destination 'generic/platform=iOS' \
  -derivedDataPath ~/.local/share/agent-device-ios/fixture/dd \
  DEVELOPMENT_TEAM=<TEAM_ID> \
  -allowProvisioningUpdates \
  build
```

Scheme and target name: `AgentDeviceFixture`. For a compile-only check use
`-destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO`.
The built app is `AgentDeviceFixture.app` under
`dd/Build/Products/Debug-iphoneos/`.

## Screens and accessibility identifiers

Two tabs: Form (tab label "Form") and Calculator (tab label "Calculator").

### Form tab

| Element                               | Identifier            | Notes                                                                       |
| ------------------------------------- | --------------------- | --------------------------------------------------------------------------- |
| Header text "Agent Device Fixture"    | `fixture.header`      | Exact text, header trait                                                    |
| Disclaimer text                       | `fixture.disclaimer`  |                                                                             |
| Name field                            | `fixture.name`        | Label "Name", placeholder "Enter name"                                      |
| Name state text                       | `fixture.name.state`  | "Name state: blank" or "Name state: N characters"                           |
| Notes field (multiline, 3 to 6 lines) | `fixture.notes`       | Label "Notes", placeholder "Enter notes"                                    |
| Notes state text                      | `fixture.notes.state` | "Notes state: blank" or "Notes state: N characters"                         |
| Choice picker (segmented)             | `fixture.choice`      | Segments "Option A" (default), "Option B"                                   |
| Toggle "Use Dark Appearance"          | `fixture.dark`        | In-app only; no system settings. Readback on the Review screen              |
| Scroll hint text                      | `fixture.scroll.hint` | Review and Reset are below ~700 pt of blank space, so scrolling is required |
| Button "Review" (the primary action)  | `fixture.review`      | Pushes the Review screen                                                    |
| Button "Reset"                        | `fixture.reset`       | Clears name, notes, choice, toggle, and calculator                          |

A blank field exposes its placeholder as the accessibility value. The state
text shows "blank" when empty, so a reader can tell a blank value from the
placeholder.

### Review screen (pushed from Form)

Navigation title "Review". Each row has a label and a value. An empty value
shows `(blank)`.

| Row                             | Label ID              | Value ID              |
| ------------------------------- | --------------------- | --------------------- |
| Name                            | `review.name.label`   | `review.name.value`   |
| Notes                           | `review.notes.label`  | `review.notes.value`  |
| Choice                          | `review.choice.label` | `review.choice.value` |
| Dark appearance ("On" or "Off") | `review.dark.label`   | `review.dark.value`   |

### Calculator tab

Addition only. Title "Fixture Calculator". Entering `137 + 248 =` shows `385`.

| Element                        | Identifier                                |
| ------------------------------ | ----------------------------------------- |
| Title                          | `calculator.title`                        |
| Disclaimer                     | `calculator.disclaimer`                   |
| Display                        | `calculator.display`                      |
| Last result ("none" until `=`) | `calculator.result`                       |
| Digit keys 0 to 9              | `calculator.key.0` ... `calculator.key.9` |
| Plus key "+"                   | `calculator.add`                          |
| Equals key "="                 | `calculator.equals`                       |
| Clear key "Clear"              | `calculator.clear`                        |

Digits are limited to 9 per entry. Entering a digit after a result starts a
new calculation. `+` after a result continues from that result.

## Expected readback example

Name `Ada`, Notes `line one`, Choice `Option B`, then Review shows
`review.name.value = Ada`, `review.notes.value = line one`,
`review.choice.value = Option B`.

## Design notes

Native SwiftUI components only, with no third-party SDK. Flat layout, labelled
fields, and one prominent action per screen. State lives in memory in
`FixtureState` and is lost when the app exits.

## Source

- `project.yml`: xcodegen spec
- `Sources/AgentDeviceFixtureApp.swift`: app entry and tabs
- `Sources/FixtureState.swift`: in-memory state and reset
- `Sources/FormScreen.swift`: Form and Review screens
- `Sources/CalculatorScreen.swift`, `Sources/AdditionCalculator.swift`: calculator UI and logic
