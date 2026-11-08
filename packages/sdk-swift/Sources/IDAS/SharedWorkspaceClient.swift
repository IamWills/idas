import Foundation

/// Client for the local authenticated IDAS shared-workspace example.
public struct SharedWorkspaceClient: Sendable {
    public struct Snapshot: Decodable, Sendable {
        public let revision: Int
        public let spec: Specification
        public let data: [String: JSONValue]
        public let mode: String

        private enum CodingKeys: String, CodingKey { case revision, spec, data, mode }
        public init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            revision = try fields.decode(Int.self, forKey: .revision)
            let specData = try JSONEncoder().encode(fields.decode(JSONValue.self, forKey: .spec))
            spec = try Specification.read(specData)
            data = try fields.decode([String: JSONValue].self, forKey: .data)
            mode = try fields.decode(String.self, forKey: .mode)
        }
    }

    public struct Preview: Decodable, Sendable {
        public struct Change: Decodable, Sendable {
            public let base: Int
            public let sections: [String]
        }
        public let change: Change
        public let reason: String?
        fileprivate let token: String
    }

    public struct RequestError: Decodable, LocalizedError, Sendable {
        public let code: String
        public let message: String
        public var errorDescription: String? { message }
    }

    private struct SnapshotReply: Decodable { let snapshot: Snapshot? }
    private struct PreviewReply: Decodable { let preview: Preview? }
    private let url: URL
    private let token: String

    public init(url: URL = URL(string: "http://127.0.0.1:4178/api/idas")!, token: String) throws {
        guard url.scheme == "http", url.host == "127.0.0.1", url.path == "/api/idas",
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            throw RequestError(code: "INVALID", message: "Expected the local IDAS workspace URL.")
        }
        self.url = url
        self.token = token
    }

    public func snapshot() async throws -> Snapshot? {
        try await request("snapshot", as: SnapshotReply.self).snapshot
    }

    public func preview(intent: String) async throws -> Preview? {
        try await request("preview", fields: ["intent": .string(intent)], as: PreviewReply.self).preview
    }

    public func recommend(device: String, task: String) async throws -> Preview? {
        let context: JSONValue = .object(["device": .string(device), "task": .string(task)])
        return try await request("recommend", fields: ["context": context], as: PreviewReply.self).preview
    }

    public func apply(_ preview: Preview) async throws -> Snapshot {
        try await mutate("apply", fields: ["token": .string(preview.token)])
    }

    public func dispatch(event: String, input: JSONValue, eventID: String) async throws -> Snapshot {
        try await mutate("dispatch", fields: ["event": .string(event), "input": input, "eventId": .string(eventID)])
    }

    public func rollback(revision: Int, expectedRevision: Int) async throws -> Snapshot {
        try await mutate("rollback", fields: ["revision": .number(Double(revision)), "expectedRevision": .number(Double(expectedRevision))])
    }

    private func mutate(_ action: String, fields: [String: JSONValue]) async throws -> Snapshot {
        guard let snapshot = try await request(action, fields: fields, as: SnapshotReply.self).snapshot else {
            throw RequestError(code: "INVALID", message: "Server returned no committed revision.")
        }
        return snapshot
    }

    private func request<T: Decodable>(_ action: String, fields: [String: JSONValue] = [:], as type: T.Type) async throws -> T {
        var body = fields
        body["action"] = .string(action)
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request, delegate: NoRedirect())
        let decoder = JSONDecoder()
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            if let failure = try? decoder.decode(RequestError.self, from: data) { throw failure }
            throw RequestError(code: "INVALID", message: "Unexpected workspace response.")
        }
        return try decoder.decode(type, from: data)
    }

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}
