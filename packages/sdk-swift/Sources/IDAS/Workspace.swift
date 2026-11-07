import SwiftUI

public struct Workspace: View {
    let spec: Specification
    let data: [String: JSONValue]
    let onEvent: (String, JSONValue) -> Void
    @State private var selected = ""
    @State private var drafts: [String: String] = [:]

    public init(spec: Specification, data: [String: JSONValue], onEvent: @escaping (String, JSONValue) -> Void) {
        self.spec = spec
        self.data = data
        self.onEvent = onEvent
    }

    public var body: some View {
        GeometryReader { geometry in
            let ui = spec.ui
            let count = ui.layout == .grid && geometry.size.width >= CGFloat(ui.collapseBelow) ? ui.columns : 1
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(ui.views) { view in Button(view.title) { selected = view.id } }
                        }
                    }
                    if let view = ui.views.first(where: { $0.id == selected }) ?? ui.views.first {
                        Text(view.title).font(.headline).accessibilityAddTraits(.isHeader)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .topLeading), count: count), spacing: 12) {
                            ForEach(view.components) { component in
                                item(component, key: view.id + "/" + component.id)
                            }
                        }
                    }
                }.padding()
            }
        }.preferredColorScheme(spec.ui.theme == .dark ? .dark : spec.ui.theme == .light ? .light : nil)
    }

    @ViewBuilder private func item(_ component: Specification.UI.View.Component, key: String) -> some View {
        let value = data[component.state ?? ""]?.display ?? ""
        switch component.kind {
        case .text: Text(component.label)
        case .value: VStack(alignment: .leading) { Text(component.label).bold(); Text(value) }
        case .button: Button(component.label) {
            if let event = component.event { onEvent(event, .null) }
        }
        case .input:
            VStack(alignment: .leading) {
                TextField(component.label, text: Binding(get: { drafts[key] ?? value }, set: { drafts[key] = String($0.prefix(1000)) }))
                Button("Save") { if let event = component.event { onEvent(event, .string(drafts[key] ?? value)) } }
            }
        }
    }
}
