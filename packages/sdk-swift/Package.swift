// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "IDAS",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "IDAS", targets: ["IDAS"]), .executable(name: "IDASDemo", targets: ["IDASDemo"])],
    targets: [
        .target(name: "IDAS"),
        .executableTarget(name: "IDASDemo", dependencies: ["IDAS"]),
        .testTarget(name: "IDASTests", dependencies: ["IDAS"], resources: [.copy("Fixtures")])
    ]
)
