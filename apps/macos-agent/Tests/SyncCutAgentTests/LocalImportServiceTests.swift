import Foundation
import XCTest
@testable import SyncCutAgent

final class LocalImportServiceTests: XCTestCase {
    func testArchiveRestoreAndVersionHistoryAreNonDestructive() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("SyncCutTests-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let source = root.appendingPathComponent("source", isDirectory: true)
        let library = root.appendingPathComponent("library", isDirectory: true)
        let audio = source.appendingPathComponent("rain.wav")
        let table = source.appendingPathComponent("assets.csv")
        let manifest = library.appendingPathComponent("manifest.json")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try Data("audio-v1".utf8).write(to: audio)
        try "素材名称,素材类型,音频附件,项目名称,集数\n雨声,音效,rain.wav,雁回关,EP015\n"
            .write(to: table, atomically: true, encoding: .utf8)

        let service = LocalImportService()
        let preview = try service.preview(tableURL: table, audioDirectory: source, manifestURL: manifest)
        XCTAssertEqual(preview.items.count, 1)
        XCTAssertTrue(preview.errors.isEmpty)

        let firstResult = try service.apply(preview, libraryDirectory: library, manifestURL: manifest)
        XCTAssertEqual(firstResult.added, 1)

        var assets = try service.listAssets(manifestURL: manifest)
        XCTAssertEqual(assets.count, 1)
        XCTAssertFalse(assets[0].isArchived)
        XCTAssertEqual(assets[0].versions.count, 1)
        let firstVersionURL = URL(fileURLWithPath: assets[0].versions[0].diskPath)
        XCTAssertTrue(FileManager.default.fileExists(atPath: firstVersionURL.path))

        try service.setArchived(assets[0].sourceID, archived: true, manifestURL: manifest)
        assets = try service.listAssets(manifestURL: manifest)
        XCTAssertTrue(assets[0].isArchived)
        XCTAssertTrue(FileManager.default.fileExists(atPath: firstVersionURL.path))

        try Data("audio-v2".utf8).write(to: audio)
        let secondPreview = try service.preview(tableURL: table, audioDirectory: source, manifestURL: manifest)
        let secondResult = try service.apply(secondPreview, libraryDirectory: library, manifestURL: manifest)
        XCTAssertEqual(secondResult.updated, 1)

        assets = try service.listAssets(manifestURL: manifest)
        XCTAssertTrue(assets[0].isArchived, "Re-import must not silently unarchive an archived asset.")
        XCTAssertEqual(assets[0].versions.count, 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: firstVersionURL.path))
        let secondVersionURL = URL(fileURLWithPath: assets[0].versions[1].diskPath)
        XCTAssertTrue(FileManager.default.fileExists(atPath: secondVersionURL.path))

        try service.setArchived(assets[0].sourceID, archived: false, manifestURL: manifest)
        assets = try service.listAssets(manifestURL: manifest)
        XCTAssertFalse(assets[0].isArchived)
        XCTAssertEqual(assets[0].versions.count, 2)
    }
}
