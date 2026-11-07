import Foundation
import IDAS
import SwiftUI

@main struct IDASDemo: App {
    @State private var message = ""
    private let spec: Result<Specification, Error> = Result {
        guard let path = CommandLine.arguments.dropFirst().first else { throw CocoaError(.fileReadNoSuchFile) }
        return try Specification.read(Data(contentsOf: URL(fileURLWithPath: path)))
    }
    var body: some Scene {
        WindowGroup {
            switch spec {
            case .success(let value):
                VStack {
                    Workspace(spec: value, data: value.state.initial) { event, input in
                        message = "Event: " + event + " " + input.display
                    }
                    if !message.isEmpty { Text(message).padding() }
                }.frame(minWidth: 360, minHeight: 400)
            case .failure(let error): Text("Pass a valid IDSS JSON path. " + error.localizedDescription).padding()
            }
        }
    }
}
