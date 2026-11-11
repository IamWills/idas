import IDAS
import SwiftUI

struct SharedWorkspaceView: View {
    let client: SharedWorkspaceClient
    @State private var snapshot: SharedWorkspaceClient.Snapshot?
    @State private var preview: SharedWorkspaceClient.Preview?
    @State private var undo: (revision: Int, expected: Int)?
    @State private var busy = false
    @State private var message = ""

    var body: some View {
        GeometryReader { geometry in
            VStack(alignment: .leading) {
                Text("Shared workspace · Revision \(snapshot?.revision ?? 0)").font(.headline)
                HStack {
                    Button("Refresh") { perform { snapshot = try await client.snapshot(); preview = nil } }
                    if let snapshot {
                        Button("Suggest a review layout") {
                            let device = geometry.size.width <= CGFloat(snapshot.spec.ui.collapseBelow) ? "phone" : "desktop"
                            perform {
                                preview = try await client.recommend(device: device, task: "review")
                                if preview == nil { message = "No layout change suggested." }
                            }
                        }
                    }
                }
                if let preview {
                    if let reason = preview.reason { Text(reason) }
                    Text("Changes: " + preview.change.sections.joined(separator: ", "))
                    HStack {
                        Button("Apply change") {
                            perform {
                                let applied = try await client.apply(preview)
                                snapshot = applied
                                undo = (preview.change.base, applied.revision)
                                self.preview = nil
                            }
                        }
                        Button("Dismiss preview") { self.preview = nil }
                    }
                }
                if let undo {
                    Button("Restore previous workspace") {
                        perform {
                            snapshot = try await client.rollback(revision: undo.revision, expectedRevision: undo.expected)
                            self.undo = nil
                            preview = nil
                        }
                    }
                }
                if !message.isEmpty { Text(message) }
                if let snapshot {
                    Workspace(spec: snapshot.spec, data: snapshot.data, mode: snapshot.mode, components: workbenchComponents) { event, input in
                        let eventID = "e-" + UUID().uuidString
                        perform { self.snapshot = try await client.dispatch(event: event, input: input, eventID: eventID) }
                    }
                } else {
                    Text("Create a workbench in the connected browser, then refresh.")
                }
            }.padding().disabled(busy)
        }.onAppear { perform { snapshot = try await client.snapshot() } }
    }

    @MainActor private func perform(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        message = ""
        Task {
            defer { busy = false }
            do { try await work() }
            catch { message = error.localizedDescription }
        }
    }
}
