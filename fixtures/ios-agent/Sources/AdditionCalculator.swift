/// Synthetic addition-only keypad logic for the acceptance fixture.
/// Entering 1 3 7 + 2 4 8 = yields result 385.
struct AdditionCalculator: Equatable {
    private(set) var entry = ""
    private(set) var total = 0
    private(set) var hasPending = false
    private(set) var result: Int?

    static let maxDigits = 9

    var display: String {
        if let result { return String(result) }
        if !entry.isEmpty { return entry }
        return hasPending ? String(total) : "0"
    }

    mutating func digit(_ value: Int) {
        guard (0...9).contains(value) else { return }
        if result != nil { self = AdditionCalculator() }
        let text = String(value)
        if entry == "0" {
            entry = text
        } else if entry.count < Self.maxDigits {
            entry += text
        }
    }

    mutating func add() {
        if let result {
            total = result
            self.result = nil
            hasPending = true
            entry = ""
        } else if let value = Int(entry) {
            total &+= value
            entry = ""
            hasPending = true
        }
    }

    mutating func equals() {
        guard result == nil else { return }
        if hasPending {
            result = total &+ (Int(entry) ?? 0)
        } else if let value = Int(entry) {
            result = value
        } else {
            return
        }
        entry = ""
        total = 0
        hasPending = false
    }

    mutating func clear() {
        self = AdditionCalculator()
    }
}
