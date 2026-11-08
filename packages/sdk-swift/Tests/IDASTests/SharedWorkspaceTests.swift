import Foundation
import XCTest
@testable import IDAS

final class SharedWorkspaceTests: XCTestCase {
    func testReadsAndUpdatesRunningSharedHost() async throws {
        guard let token = ProcessInfo.processInfo.environment["IDAS_SHARED_TEST_TOKEN"] else {
            throw XCTSkip("Set IDAS_SHARED_TEST_TOKEN for a running shared host with disposable data.")
        }
        let client = try SharedWorkspaceClient(token: token)
        let initial = try await client.snapshot()
        if initial == nil {
            let initialPreview = try await client.preview(intent: "Create a developer workbench")
            _ = try await client.apply(XCTUnwrap(initialPreview))
        }
        let current = try await client.snapshot()
        let original = try XCTUnwrap(current)
        let recommendation = try await client.recommend(device: "phone", task: "review")
        let preview = try XCTUnwrap(recommendation)
        XCTAssertTrue(preview.reason?.contains("phone") == true)
        let afterPreview = try await client.snapshot()
        XCTAssertEqual(afterPreview?.revision, original.revision)
        let applied = try await client.apply(preview)
        XCTAssertEqual(applied.spec.ui.presentation?.compactMode, .pages)
        let restored = try await client.rollback(revision: original.revision, expectedRevision: applied.revision)
        XCTAssertEqual(restored.spec.ui.presentation?.compactMode, .stack)
        let event = try await client.dispatch(event: "edit", input: .string("export const ready = false;"),
                                              eventID: "swift-" + UUID().uuidString)
        XCTAssertEqual(event.data["draft"], .string("export const ready = false;"))
    }
}
