import Foundation
import IDAS
import SwiftUI

@main struct IDASDemo: App {
    @State private var message = ""
    private let spec: Result<Specification, Error> = Result {
        guard let path = CommandLine.arguments.dropFirst().first, path != "--shared" else { throw CocoaError(.fileReadNoSuchFile) }
        return try Specification.read(Data(contentsOf: URL(fileURLWithPath: path)))
    }
    private var shared: Bool { CommandLine.arguments.dropFirst().first == "--shared" }
    var body: some Scene {
        WindowGroup {
            if shared {
                if let token = ProcessInfo.processInfo.environment["IDAS_SHARED_TOKEN"],
                   let client = try? SharedWorkspaceClient(token: token) {
                    SharedWorkspaceView(client: client).frame(minWidth: 360, minHeight: 400)
                } else {
                    Text("Set IDAS_SHARED_TOKEN before opening the shared workspace.").padding()
                }
            } else {
                offlineView
            }
        }
    }

    @ViewBuilder private var offlineView: some View {
        switch spec {
        case .success(let value):
            VStack {
                Workspace(spec: value, data: value.state.initial, components: workbenchComponents) { event, input in
                    message = "Event: " + event + " " + input.display
                }
                if !message.isEmpty { Text(message).padding() }
            }.frame(minWidth: 360, minHeight: 400)
        case .failure(let error): Text("Pass a valid IDSS JSON path. " + error.localizedDescription).padding()
        }
    }
}
