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
    func testWorkbenchUsesSameWideRowsAndCompactNavigationAsTypeScript() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "workbench", withExtension: "json", subdirectory: "Fixtures"))
        let bytes = try Data(contentsOf: url)
        let spec = try Specification.read(bytes)
        XCTAssertEqual(spec.ui.presentation?.wide, [["files", "editor"], ["agent"]])
        XCTAssertEqual(spec.ui.presentation?.compact, ["editor", "files", "agent"])
        XCTAssertEqual(spec.ui.presentation?.compactMode, .pages)
        let editor = try XCTUnwrap(spec.ui.views.first(where: { $0.id == "editor" }))
        XCTAssertEqual(editor.components.first(where: { $0.id == "source" })?.multiline, true)
        XCTAssertEqual(editor.components.first(where: { $0.id == "confirm" })?.modes, ["review"])
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        var ui = try XCTUnwrap(object["ui"] as? [String: Any])
        ui["presentation"] = ["wide": [["editor", "files"], ["agent"]], "compact": ["editor", "agent", "agent"]]
        object["ui"] = ui
        XCTAssertThrowsError(try Specification.read(JSONSerialization.data(withJSONObject: object)))
    }
}
