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
                public enum Kind: String, Decodable, Sendable { case text, button, input, value, layout, plugin, form }
                public let id: String
                public let kind: Kind
                public let label: String
                public let event: String?
                public let state: String?
                public let modes: [String]?
                public let multiline: Bool?
                public enum NestedLayout: String, Decodable, Sendable { case stack, row, grid }
                public let layout: NestedLayout?
                public let columns: Int?
                public let children: [Self]?
                public let capability: String?
                public let version: String?
                public let props: [String: JSONValue]?
                public let bindings: [String: StateBinding]?
                public struct Field: Decodable, Sendable, Identifiable {
                    public enum Kind: String, Decodable, Sendable { case text, number, boolean, choice }
                    public struct Option: Decodable, Sendable { public let value: String; public let label: String }
                    public let id: String
                    public let label: String
                    public let kind: Kind
                    public let required: Bool?
                    public let binding: StateBinding?
                    public let minLength: Int?
                    public let maxLength: Int?
                    public let min: Double?
                    public let max: Double?
                    public let options: [Option]?
                }
                public let fields: [Field]?
            }
            public let id: String
            public let title: String
            public let components: [Component]
        }
        public let layout: Layout
        public let columns: Int
        public let collapseBelow: Int
        public let theme: Theme
        public struct Presentation: Decodable, Sendable {
            public let wide: [[String]]
            public enum CompactMode: String, Decodable, Sendable { case stack, pages }
            public let compact: [String]
            public let compactMode: CompactMode?
        }
        public let views: [View]
        public let presentation: Presentation?
        public struct Navigation: Decodable, Sendable {
            public struct Route: Decodable, Hashable, Sendable { public let from: String; public let to: String }
            public let initial: String
            public let routes: [Route]
        }
        public let navigation: Navigation?
    }
    public struct State: Decodable, Sendable { public let initial: [String: JSONValue] }
    public struct Interaction: Decodable, Sendable { public let initial: String }
    public struct Metadata: Decodable, Sendable { public let schemaVersion: Int }
    public struct Capability: Decodable, Sendable {
        public let id: String
        public let range: String
    }
    public let ui: UI
    public let state: State
    public let interaction: Interaction?
    public let capabilities: [Capability]?
    public let metadata: Metadata

    public enum ReadError: Error { case unsupportedVersion, invalidPresentation }
    public static func read(_ bytes: Data) throws -> Self {
        guard bytes.count <= 2_500_000 else { throw ReadError.invalidPresentation }
        let decoded = try JSONDecoder().decode(Self.self, from: bytes)
        guard decoded.metadata.schemaVersion == 1 else { throw ReadError.unsupportedVersion }
        let ui = decoded.ui
        guard (1...4).contains(ui.columns), (320...1600).contains(ui.collapseBelow), (1...20).contains(ui.views.count),
              Set(ui.views.map(\.id)).count == ui.views.count else { throw ReadError.invalidPresentation }
        for view in ui.views {
            var identifiers = Set<String>()
            func valid(_ component: UI.View.Component, depth: Int) -> Bool {
                guard depth <= 12, identifiers.count < 100, identifiers.insert(component.id).inserted else { return false }
                switch component.kind {
                case .button: return component.event != nil
                case .input: return component.event != nil && component.state.flatMap { decoded.state.initial[$0] } != nil
                case .value: return component.state.flatMap { decoded.state.initial[$0] } != nil
                case .text: return true
                case .layout:
                    guard let layout = component.layout, let children = component.children,
                          component.columns.map({ layout == .grid && (1...4).contains($0) }) ?? true else { return false }
                    return children.allSatisfy { valid($0, depth: depth + 1) }
                case .form:
                    guard component.event != nil, let fields = component.fields, (1...20).contains(fields.count),
                          Set(fields.map(\.id)).count == fields.count else { return false }
                    return fields.allSatisfy { field in
                        switch field.kind {
                        case .text: return (field.minLength ?? 0) >= 0 && (field.minLength ?? 0) <= (field.maxLength ?? 1000) &&
                            (1...1000).contains(field.maxLength ?? 1000)
                        case .number: return (field.min ?? -.infinity) <= (field.max ?? .infinity)
                        case .boolean: return true
                        case .choice:
                            guard let options = field.options, (1...30).contains(options.count) else { return false }
                            return Set(options.map(\.value)).count == options.count
                        }
                    }
                case .plugin:
                    guard let capability = component.capability, capability.hasPrefix("ui."), capability.count > 3,
                          let version = component.version, version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil,
                          decoded.capabilities?.contains(where: { $0.id == capability && $0.range == version }) == true else { return false }
                    return (component.bindings ?? [:]).allSatisfy { key, state in
                        component.props?[key] == nil && state.value(in: decoded.state.initial) != nil
                    }
                }
            }
            guard view.components.allSatisfy({ valid($0, depth: 1) }) else { throw ReadError.invalidPresentation }
        }
        if let navigation = ui.navigation {
            let ids = Set(ui.views.map(\.id))
            guard ids.contains(navigation.initial), navigation.routes.count <= 380,
                  Set(navigation.routes).count == navigation.routes.count,
                  navigation.routes.allSatisfy({ ids.contains($0.from) && ids.contains($0.to) && $0.from != $0.to }) else {
                throw ReadError.invalidPresentation
            }
            var reachable = Set([navigation.initial])
            var pending = [navigation.initial]
            while let id = pending.popLast() {
                for route in navigation.routes where route.from == id && reachable.insert(route.to).inserted {
                    pending.append(route.to)
                }
            }
            guard reachable == ids else { throw ReadError.invalidPresentation }
        }
        if let presentation = ui.presentation {
            let viewIDs = Set(ui.views.map(\.id))
            let wide = presentation.wide.flatMap { $0 }
            guard presentation.wide.allSatisfy({ (1...4).contains($0.count) }),
                  wide.count == viewIDs.count, Set(wide) == viewIDs,
                  presentation.compact.count == viewIDs.count, Set(presentation.compact) == viewIDs,
                  presentation.compactMode != .stack || presentation.compact == wide else {
                throw ReadError.invalidPresentation
            }
        }
        return decoded
    }
}
