import Foundation
import XCTest
@testable import IDAS

final class SpecificationTests: XCTestCase {
    func testReadsExportFromTypeScriptAndRejectsFutureVersion() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "workspace", withExtension: "json", subdirectory: "Fixtures"))
        let bytes = try Data(contentsOf: url)
        let spec = try Specification.read(bytes)
        XCTAssertEqual(spec.ui.columns, 2)
        XCTAssertEqual(spec.ui.theme, .dark)
        XCTAssertEqual(spec.ui.views.first?.components.last?.event, "run")
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        object["metadata"] = ["schemaVersion": 999]
        XCTAssertThrowsError(try Specification.read(JSONSerialization.data(withJSONObject: object)))
    }
}
