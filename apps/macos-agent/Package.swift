// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SyncCutAgent",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "SyncCutAgent", targets: ["SyncCutAgent"])
    ],
    targets: [
        .executableTarget(name: "SyncCutAgent"),
        .testTarget(name: "SyncCutAgentTests", dependencies: ["SyncCutAgent"])
    ]
)
