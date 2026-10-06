import SwiftUI

struct CalculatorScreen: View {
    @Environment(FixtureState.self) private var state

    private let rows: [[Int]] = [[7, 8, 9], [4, 5, 6], [1, 2, 3]]

    var body: some View {
        @Bindable var state = state
        VStack(alignment: .leading, spacing: 16) {
            Text("Fixture Calculator")
                .font(.largeTitle.bold())
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("calculator.title")
            Text("Synthetic addition fixture. Not the system Calculator.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("calculator.disclaimer")

            Text(state.calculator.display)
                .font(.system(size: 44, weight: .semibold, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding()
                .background(Color.secondary.opacity(0.12))
                .accessibilityIdentifier("calculator.display")

            HStack {
                Text("Last result").font(.headline)
                Spacer()
                Text(state.calculator.result.map(String.init) ?? "none")
                    .accessibilityIdentifier("calculator.result")
            }

            VStack(spacing: 10) {
                ForEach(rows, id: \.self) { row in
                    HStack(spacing: 10) {
                        ForEach(row, id: \.self) { digitKey($0) }
                    }
                }
                HStack(spacing: 10) {
                    keyButton("Clear", id: "calculator.clear", role: .destructive) { state.calculator.clear() }
                    digitKey(0)
                    keyButton("+", id: "calculator.add") { state.calculator.add() }
                }
                Button {
                    state.calculator.equals()
                } label: {
                    Text("=").frame(maxWidth: .infinity, minHeight: 36)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("calculator.equals")
            }
            Spacer(minLength: 0)
        }
        .padding()
        .frame(maxWidth: 500)
        .frame(maxWidth: .infinity)
    }

    private func digitKey(_ value: Int) -> some View {
        keyButton(String(value), id: "calculator.key.\(value)") { state.calculator.digit(value) }
    }

    private func keyButton(_ title: String, id: String, role: ButtonRole? = nil, action: @escaping () -> Void) -> some View {
        Button(role: role, action: action) {
            Text(title).font(.title2).frame(maxWidth: .infinity, minHeight: 36)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .accessibilityIdentifier(id)
    }
}
