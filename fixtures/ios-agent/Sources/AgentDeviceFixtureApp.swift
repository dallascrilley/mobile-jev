import SwiftUI

@main
struct AgentDeviceFixtureApp: App {
    @State private var state = FixtureState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(state)
                .preferredColorScheme(state.useDarkAppearance ? .dark : nil)
        }
    }
}

struct RootView: View {
    var body: some View {
        TabView {
            FormScreen()
            .tabItem { Label("Form", systemImage: "doc.text") }

            CalculatorScreen()
                .tabItem { Label("Calculator", systemImage: "plus.square") }
        }
    }
}
