import SwiftUI

struct TypedForm: View {
    typealias Field = Specification.UI.View.Component.Field
    let label: String
    let fields: [Field]
    let data: [String: JSONValue]
    let submit: (JSONValue) -> Void
    @State private var drafts: [String: JSONValue] = [:]
    @State private var error: String?

    private func rawValue(_ field: Field) -> JSONValue? {
        drafts[field.id] ?? field.binding?.value(in: data)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(label).font(.headline)
            ForEach(fields) { field in
                let value = Binding(get: { rawValue(field)?.display ?? "" }, set: { drafts[field.id] = .string($0); error = nil })
                switch field.kind {
                case .boolean:
                    Toggle(field.label, isOn: Binding(get: { rawValue(field) == .boolean(true) },
                        set: { drafts[field.id] = .boolean($0); error = nil }))
                case .choice:
                    Picker(field.label, selection: value) {
                        Text("Select an option").tag("")
                        ForEach(field.options ?? [], id: \.value) { option in Text(option.label).tag(option.value) }
                    }
                case .text, .number: TextField(field.label, text: value)
                }
            }
            Button("Submit", action: send)
            if let error { Text(error).foregroundStyle(.red) }
        }
    }

    private func send() {
        var payload: [String: JSONValue] = [:]
        for field in fields {
            let raw = rawValue(field)
            let text = raw?.display ?? ""
            if field.kind != .boolean && text.isEmpty && field.required != true { continue }
            guard let value = Self.parse(field, text: text, raw: raw) else {
                error = "Invalid value for " + field.label
                return
            }
            payload[field.id] = value
        }
        error = nil
        submit(.object(payload))
    }

    static func parse(_ field: Field, text: String, raw: JSONValue?) -> JSONValue? {
        switch field.kind {
        case .boolean: return .boolean(raw == .boolean(true))
        case .choice:
            return field.options?.contains(where: { $0.value == text }) == true ? .string(text) : nil
        case .text:
            let count = text.utf16.count
            guard count >= (field.minLength ?? (field.required == true ? 1 : 0)), count <= (field.maxLength ?? 1000),
                  field.required != true || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return .string(text)
        case .number:
            guard let number = Double(text), number.isFinite,
                  number >= (field.min ?? -.infinity), number <= (field.max ?? .infinity) else { return nil }
            return .number(number)
        }
    }
}
