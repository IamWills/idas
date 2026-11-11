import IDAS
import SwiftUI

let workbenchComponents: [String: NativeComponent] = [
    "ui.workbench.status@1.0.0": NativeComponent(properties: ["value": .init(.string, required: true)], emitsEvent: true) { label, values, emit in
        VStack(alignment: .leading) {
            Text(label).bold()
            Text(values["value"]?.display ?? "")
            if let emit { Button("Acknowledge status") { emit(.null) } }
        }
    }
]
