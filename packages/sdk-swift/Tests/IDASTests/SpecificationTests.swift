import Foundation
import XCTest
import SwiftUI
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
    func testNestedPluginUsesVersionedNativeBinding() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "composition", withExtension: "json", subdirectory: "Fixtures"))
        let spec = try Specification.read(Data(contentsOf: url))
        let panel = try XCTUnwrap(spec.ui.views.first(where: { $0.id == "agent" }))
        let node = try XCTUnwrap(panel.components.first?.children?.first?.children?.first)
        XCTAssertEqual(node.capability, "ui.workbench.status")
        XCTAssertEqual(node.version, "1.0.0")
        let component = NativeComponent(properties: ["value": .init(.string, required: true)], emitsEvent: true) { _, values, _ in
            Text(values["value"]?.display ?? "")
        }
        XCTAssertEqual(component.values(for: node, data: spec.state.initial), ["value": .string("Ready")])
        XCTAssertEqual(component.values(for: node, data: ["status": .string("Acknowledged")]), ["value": .string("Acknowledged")])
        XCTAssertNil(component.values(for: node, data: ["status": .number(42)]))
    }
    func testTypedFormDecodesSharedBindingsAndRejectsInvalidNumbers() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "forms", withExtension: "json", subdirectory: "Fixtures"))
        let bytes = try Data(contentsOf: url)
        let spec = try Specification.read(bytes)
        let agent = try XCTUnwrap(spec.ui.views.first(where: { $0.id == "agent" }))
        let form = try XCTUnwrap(agent.components.first(where: { $0.kind == .form }))
        let attempts = try XCTUnwrap(form.fields?.first(where: { $0.id == "attempts" }))
        XCTAssertEqual(attempts.binding?.value(in: spec.state.initial), .number(2))
        XCTAssertEqual(TypedForm.parse(attempts, text: "3", raw: nil), .number(3))
        XCTAssertNil(TypedForm.parse(attempts, text: "10", raw: nil))
        XCTAssertEqual(spec.ui.navigation?.initial, "editor")
        XCTAssertEqual(StateBinding.path(state: "list", segments: ["0", "title"])
            .value(in: ["list": .array([.object(["title": .string("First")])])]), .string("First"))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        var ui = try XCTUnwrap(object["ui"] as? [String: Any])
        ui["navigation"] = ["initial": "editor", "routes": []] as [String: Any]
        object["ui"] = ui
        XCTAssertThrowsError(try Specification.read(JSONSerialization.data(withJSONObject: object)))
    }
}
