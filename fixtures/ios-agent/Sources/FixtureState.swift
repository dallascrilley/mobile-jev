import Observation

/// Form-side state of the fixture. Held in memory only; nothing is persisted.
@Observable
final class FixtureState {
    enum Choice: String, CaseIterable, Identifiable {
        case optionA = "Option A"
        case optionB = "Option B"
        var id: String { rawValue }
    }

    var name = ""
    var notes = ""
    var choice: Choice = .optionA
    var useDarkAppearance = false
    var calculator = AdditionCalculator()

    func reset() {
        name = ""
        notes = ""
        choice = .optionA
        useDarkAppearance = false
        calculator = AdditionCalculator()
    }
}
