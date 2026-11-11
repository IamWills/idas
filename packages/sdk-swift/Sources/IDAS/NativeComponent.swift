import SwiftUI

/// A host-provided renderer for one exact component capability version.
public struct NativeComponent {
    public struct Property: Sendable {
        public enum Kind: Sendable { case string, number, boolean, json }
        let kind: Kind
        let required: Bool
        public init(_ kind: Kind, required: Bool = false) {
            self.kind = kind
            self.required = required
        }

        func accepts(_ value: JSONValue) -> Bool {
            switch (kind, value) {
            case (.json, _), (.string, .string), (.number, .number), (.boolean, .boolean): return true
            default: return false
            }
        }
    }

    private let properties: [String: Property]
    private let emitsEvent: Bool
    let render: (String, [String: JSONValue], ((JSONValue) -> Void)?) -> AnyView

    public init<Content: View>(properties: [String: Property], emitsEvent: Bool = false,
                               @ViewBuilder render: @escaping (String, [String: JSONValue], ((JSONValue) -> Void)?) -> Content) {
        self.properties = properties
        self.emitsEvent = emitsEvent
        self.render = { label, props, emit in AnyView(render(label, props, emit)) }
    }

    func values(for node: Specification.UI.View.Component, data: [String: JSONValue]) -> [String: JSONValue]? {
        guard node.event == nil || emitsEvent else { return nil }
        var result = node.props ?? [:]
        for (key, state) in node.bindings ?? [:] {
            guard result[key] == nil, let value = state.value(in: data) else { return nil }
            result[key] = value
        }
        guard result.allSatisfy({ properties[$0.key]?.accepts($0.value) == true }),
              properties.allSatisfy({ !$0.value.required || result[$0.key] != nil }) else { return nil }
        return result
    }
}
