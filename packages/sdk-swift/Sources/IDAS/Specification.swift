import Foundation

public enum JSONValue: Codable, Equatable, Sendable {
    case null, boolean(Bool), number(Double), string(String), array([Self]), object([String: Self])

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .boolean(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode([Self].self) { self = .array(v) }
        else { self = .object(try value.decode([String: Self].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .boolean(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
    public var display: String {
        if case .null = self { return "" }
        if case .string(let value) = self { return value }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
}

/// Presentation projection of IDSS/1. Workflows and authorization remain in the trusted engine.
public struct Specification: Decodable, Sendable {
    public struct UI: Decodable, Sendable {
        public enum Layout: String, Decodable, Sendable { case stack, grid }
        public enum Theme: String, Decodable, Sendable { case light, dark, system }
        public struct View: Decodable, Sendable, Identifiable {
            public struct Component: Decodable, Sendable, Identifiable {
                public enum Kind: String, Decodable, Sendable { case text, button, input, value }
                public let id: String
                public let kind: Kind
                public let label: String
                public let event: String?
                public let state: String?
            }
            public let id: String
            public let title: String
            public let components: [Component]
        }
        public let layout: Layout
        public let columns: Int
        public let collapseBelow: Int
        public let theme: Theme
        public let views: [View]
    }
    public struct State: Decodable, Sendable { public let initial: [String: JSONValue] }
    public struct Metadata: Decodable, Sendable { public let schemaVersion: Int }
    public let ui: UI
    public let state: State
    public let metadata: Metadata

    public enum ReadError: Error { case unsupportedVersion, invalidPresentation }
    public static func read(_ bytes: Data) throws -> Self {
        guard bytes.count <= 2_500_000 else { throw ReadError.invalidPresentation }
        let decoded = try JSONDecoder().decode(Self.self, from: bytes)
        guard decoded.metadata.schemaVersion == 1 else { throw ReadError.unsupportedVersion }
        let ui = decoded.ui
        guard (1...4).contains(ui.columns), (320...1600).contains(ui.collapseBelow), (1...20).contains(ui.views.count),
            Set(ui.views.map(\.id)).count == ui.views.count,
            ui.views.allSatisfy({ view in
                view.components.count <= 100 && Set(view.components.map(\.id)).count == view.components.count &&
                view.components.allSatisfy({ c in
                    switch c.kind {
                    case .button: return c.event != nil
                    case .input: return c.event != nil && c.state.flatMap { decoded.state.initial[$0] } != nil
                    case .value: return c.state.flatMap { decoded.state.initial[$0] } != nil
                    case .text: return true
                    }
                })
            }) else { throw ReadError.invalidPresentation }
        return decoded
    }
}
