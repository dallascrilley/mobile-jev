import SwiftUI

struct FormScreen: View {
    @State private var path: [Route] = []

    enum Route: Hashable { case review }

    var body: some View {
        NavigationStack(path: $path) {
            formContent
                .navigationDestination(for: Route.self) { _ in
                    ReviewScreen()
                }
        }
    }

    private var formContent: some View {
        FormFields(onReview: { path.append(.review) })
    }
}

private struct FormFields: View {
    @Environment(FixtureState.self) private var state
    let onReview: () -> Void

    var body: some View {
        @Bindable var state = state
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Agent Device Fixture")
                    .font(.largeTitle.bold())
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("fixture.header")

                Text("Synthetic acceptance fixture. Stores nothing and uses no network.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("fixture.disclaimer")

                VStack(alignment: .leading, spacing: 6) {
                    Text("Name").font(.headline)
                    TextField("Enter name", text: $state.name)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("Name")
                        .accessibilityIdentifier("fixture.name")
                    Text(state.name.isEmpty ? "Name state: blank" : "Name state: \(state.name.count) characters")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("fixture.name.state")
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Notes").font(.headline)
                    TextField("Enter notes", text: $state.notes, axis: .vertical)
                        .lineLimit(3...6)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("Notes")
                        .accessibilityIdentifier("fixture.notes")
                    Text(state.notes.isEmpty ? "Notes state: blank" : "Notes state: \(state.notes.count) characters")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("fixture.notes.state")
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Choice").font(.headline)
                    Picker("Choice", selection: $state.choice) {
                        ForEach(FixtureState.Choice.allCases) { choice in
                            Text(choice.rawValue).tag(choice)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("fixture.choice")
                }

                Toggle("Use Dark Appearance", isOn: $state.useDarkAppearance)
                    .accessibilityIdentifier("fixture.dark")

                Text("Scroll down to Review and Reset.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("fixture.scroll.hint")

                // Blank filler that forces a scroll before the buttons appear.
                Color.clear
                    .frame(height: 700)
                    .accessibilityHidden(true)

                Button {
                    onReview()
                } label: {
                    Text("Review").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("fixture.review")

                Button(role: .destructive) {
                    state.reset()
                } label: {
                    Text("Reset").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .accessibilityIdentifier("fixture.reset")
            }
            .padding()
            .frame(maxWidth: 700, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .toolbar(.hidden, for: .navigationBar)
    }
}

struct ReviewScreen: View {
    @Environment(FixtureState.self) private var state

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                row("Name", value: state.name, id: "review.name")
                row("Notes", value: state.notes, id: "review.notes")
                row("Choice", value: state.choice.rawValue, id: "review.choice")
                row("Dark appearance", value: state.useDarkAppearance ? "On" : "Off", id: "review.dark")
            }
            .padding()
            .frame(maxWidth: 700, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Review")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Shows the exact stored value; an empty value is shown as "(blank)".
    private func row(_ label: String, value: String, id: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("\(id).label")
            Text(value.isEmpty ? "(blank)" : value)
                .font(.body)
                .accessibilityIdentifier("\(id).value")
        }
    }
}
