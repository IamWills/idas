import Foundation

public enum StateBinding: Decodable, Sendable {
    case key(String)
    case path(state: String, segments: [String])

    private struct Nested: Decodable { let state: String; let path: [String] }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let key = try? container.decode(String.self) {
            self = .key(key)
        } else {
            let nested = try container.decode(Nested.self)
            guard (1...12).contains(nested.path.count),
                  nested.path.allSatisfy({ !["__proto__", "constructor", "prototype"].contains($0) }) else {
                throw Specification.ReadError.invalidPresentation
            }
            self = .path(state: nested.state, segments: nested.path)
        }
    }

    public func value(in data: [String: JSONValue]) -> JSONValue? {
        switch self {
        case .key(let key): return data[key]
        case .path(let state, let segments):
            var value = data[state]
            for segment in segments {
                switch value {
                case .object(let object): value = object[segment]
                case .array(let array):
                    guard let index = Int(segment), String(index) == segment, array.indices.contains(index) else { return nil }
                    value = array[index]
                default: return nil
                }
            }
            return value
        }
    }
}
