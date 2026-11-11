import SwiftUI

public struct Workspace: View {
    let spec: Specification
    let data: [String: JSONValue]
    let mode: String?
    let components: [String: NativeComponent]
    let disabled: Bool
    let onEvent: (String, JSONValue) -> Void
    @State private var selected = ""
    @State private var drafts: [String: String] = [:]

    public init(spec: Specification, data: [String: JSONValue], mode: String? = nil,
                components: [String: NativeComponent] = [:], disabled: Bool = false, onEvent: @escaping (String, JSONValue) -> Void) {
        self.spec = spec
        self.data = data
        self.mode = mode ?? spec.interaction?.initial
        self.onEvent = onEvent
        self.components = components
        self.disabled = disabled
    }

    public var body: some View {
        GeometryReader { geometry in
            let ui = spec.ui
            let count = ui.layout == .grid && geometry.size.width >= CGFloat(ui.collapseBelow) ? ui.columns : 1
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let presentation = ui.presentation, geometry.size.width > CGFloat(ui.collapseBelow) {
                        ForEach(presentation.wide, id: \.self) { row in
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .topLeading), count: row.count), spacing: 12) {
                                ForEach(row, id: \.self) { id in
                                    if let view = ui.views.first(where: { $0.id == id }) { panel(view, columns: 1) }
                                }
                            }
                        }
                    } else {
                        let views = ui.presentation?.compact.compactMap { id in ui.views.first { $0.id == id } } ?? ui.views
                        if ui.presentation?.compactMode == .stack {
                            ForEach(views) { view in panel(view, columns: 1) }
                        } else {
                            let active = views.first(where: { $0.id == selected })
                                ?? views.first(where: { $0.id == ui.navigation?.initial }) ?? views.first
                            let reachable = views.filter { view in
                                guard let navigation = ui.navigation else { return true }
                                return view.id == active?.id || navigation.routes.contains { $0.from == active?.id && $0.to == view.id }
                            }
                            ScrollView(.horizontal) {
                                HStack {
                                    ForEach(reachable) { view in Button(view.title) { selected = view.id } }
                                }
                            }
                            if let active { panel(active, columns: count) }
                        }
                    }
                }.padding()
            }
        }.disabled(disabled).preferredColorScheme(spec.ui.theme == .dark ? .dark : spec.ui.theme == .light ? .light : nil)
    }

    private func panel(_ view: Specification.UI.View, columns: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(view.title).font(.headline).accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .topLeading), count: columns), spacing: 12) {
                ForEach(view.components) { component in
                    if component.modes == nil || component.modes?.contains(mode ?? "") == true {
                        item(component, key: view.id + "/" + component.id)
                    }
                }
            }
        }
    }

    @ViewBuilder private func item(_ component: Specification.UI.View.Component, key: String) -> some View {
        let value = data[component.state ?? ""]?.display ?? ""
        switch component.kind {
        case .text: Text(component.label)
        case .value: VStack(alignment: .leading) { Text(component.label).bold(); Text(value) }
        case .button: Button(component.label) {
            if let event = component.event { onEvent(event, .null) }
        }
        case .layout:
            VStack(alignment: .leading) {
                if !component.label.isEmpty { Text(component.label).font(.subheadline).accessibilityAddTraits(.isHeader) }
                if component.layout == .row {
                    HStack(alignment: .top) { children(component, key: key) }
                } else if component.layout == .grid {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: component.columns ?? 2)) {
                        children(component, key: key)
                    }
                } else {
                    VStack(alignment: .leading) { children(component, key: key) }
                }
            }
        case .plugin:
            if let capability = component.capability, let version = component.version,
               let native = components[capability + "@" + version] {
                if let props = native.values(for: component, data: data) {
                    native.render(component.label, props, eventHandler(component.event))
                } else {
                    Text(component.label + ": invalid properties.")
                }
            } else {
                Text(component.label + ": unavailable on this host.")
            }
        case .form:
            if let event = component.event {
                TypedForm(label: component.label, fields: component.fields ?? [], data: data) { payload in
                    if !disabled { onEvent(event, payload) }
                }
            }
        case .input:
            VStack(alignment: .leading) {
                let draft = Binding(get: { drafts[key] ?? value }, set: { drafts[key] = String($0.prefix(1000)) })
                if component.multiline == true {
                    TextEditor(text: draft).frame(minHeight: 100).accessibilityLabel(component.label)
                } else {
                    TextField(component.label, text: draft)
                }
                Button("Save") { if let event = component.event { onEvent(event, .string(drafts[key] ?? value)) } }
            }
        }
    }
    private func eventHandler(_ event: String?) -> ((JSONValue) -> Void)? {
        guard let event, !disabled else { return nil }
        return { onEvent(event, $0) }
    }

    private func children(_ component: Specification.UI.View.Component, key: String) -> some View {
        ForEach(component.children ?? []) { child in
            if child.modes == nil || child.modes?.contains(mode ?? "") == true {
                AnyView(item(child, key: key + "/" + child.id))
            }
        }
    }

}
