import Foundation
import CryptoKit
import AVFoundation

func check(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
    print("PASS: \(message)")
}
let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("SyncCutSmoke-" + UUID().uuidString)
defer { try? fm.removeItem(at: root) }
let a = root.appendingPathComponent("a"), b = root.appendingPathComponent("b"), nested = a.appendingPathComponent("nested")
let library = root.appendingPathComponent("library"), manifest = library.appendingPathComponent("manifest.json")
try fm.createDirectory(at: nested, withIntermediateDirectories: true)
try fm.createDirectory(at: b, withIntermediateDirectories: true)
let one = a.appendingPathComponent("rain.wav"), two = b.appendingPathComponent("rain.wav"), three = nested.appendingPathComponent("wind.mp3")
try Data("one".utf8).write(to: one); try Data("two".utf8).write(to: two); try Data("three".utf8).write(to: three)
try Data("no".utf8).write(to: a.appendingPathComponent("note.txt"))
let service = LocalImportService()
let single = try service.scanAudio([one], libraryDirectory: library, manifestURL: manifest)
check(single.preview.items.count == 1, "single file")
let scan = try service.scanAudio([a, b, one], libraryDirectory: library, manifestURL: manifest)
check(scan.preview.items.count == 3, "recursive directories and same-name files")
check(scan.notices.count == 2, "unsupported and duplicate reported")
let before = try Data(contentsOf: one)
let result = try service.apply(scan.preview, libraryDirectory: library, manifestURL: manifest)
check(result.added == 3, "three files imported")
check((try Data(contentsOf: one)) == before, "source preserved")
var assets = try service.listAssets(manifestURL: manifest)
check(assets.count == 3, "same filename has distinct identities")
let repeatScan = try service.scanAudio([one], libraryDirectory: library, manifestURL: manifest)
check(repeatScan.unchanged == 1 && repeatScan.preview.items.isEmpty, "unchanged skipped")
try Data("changed".utf8).write(to: one)
let changed = try service.scanAudio([one], libraryDirectory: library, manifestURL: manifest)
let updated = try service.apply(changed.preview, libraryDirectory: library, manifestURL: manifest)
check(updated.updated == 1, "changed source creates version")
assets = try service.listAssets(manifestURL: manifest)
let versioned = assets.first { $0.sourceID == changed.preview.items[0].sourceID }!
check(versioned.versions.count == 2 && fm.fileExists(atPath: versioned.versions[0].diskPath), "old version preserved")
let stale = try service.scanAudio([one], libraryDirectory: library, manifestURL: manifest)
try Data("new".utf8).write(to: three)
let stale2 = try service.scanAudio([three], libraryDirectory: library, manifestURL: manifest)
try Data("after-preview".utf8).write(to: three)
do { _ = try service.apply(stale2.preview, libraryDirectory: library, manifestURL: manifest); check(false, "stale rejected") }
catch { print("PASS: stale preview rejected") }
check(stale.preview.items.isEmpty, "unchanged scan")
try service.setArchived(versioned.sourceID, archived: true, manifestURL: manifest)
check((try service.listAssets(manifestURL: manifest)).first { $0.sourceID == versioned.sourceID }!.isArchived, "archive")
try service.setArchived(versioned.sourceID, archived: false, manifestURL: manifest)
var metadata = versioned.metadata; metadata.project = "Project"; metadata.kind = "sfx"
try service.updateMetadata(versioned.sourceID, metadata: metadata, manifestURL: manifest)
check((try service.listAssets(manifestURL: manifest)).first { $0.sourceID == versioned.sourceID }!.metadata.project == "Project", "metadata edit")
let empty = root.appendingPathComponent("empty"); try fm.createDirectory(at: empty, withIntermediateDirectories: true)
check((try service.scanAudio([empty], libraryDirectory: library, manifestURL: manifest)).notices.count == 1, "empty folder")
let csv = root.appendingPathComponent("assets.csv")
try "素材名称,素材类型,音频附件\nRain,音效,rain.wav\n".write(to: csv, atomically: true, encoding: .utf8)
let csvPreview = try service.preview(tableURL: csv, audioDirectory: a, manifestURL: manifest)
check(csvPreview.items.count == 1 && csvPreview.errors.isEmpty, "CSV preview")
let csvResult = try service.apply(csvPreview, libraryDirectory: library, manifestURL: manifest)
check(csvResult.added == 1, "CSV import")
let badLibrary = root.appendingPathComponent("rollback-library")
let badManifest = badLibrary.appendingPathComponent("manifest.json")
let rollbackPreview = try service.scanAudio([one, two], libraryDirectory: badLibrary, manifestURL: badManifest)
let secondID = rollbackPreview.preview.items[1].sourceID
let secondFolder = badLibrary.appendingPathComponent(SHA256.hash(data: Data(secondID.utf8)).map { String(format: "%02x", $0) }.joined())
try fm.createDirectory(at: secondFolder, withIntermediateDirectories: true)
let sentinel = secondFolder.appendingPathComponent("v0001.wav")
try Data("existing".utf8).write(to: sentinel)
do { _ = try service.apply(rollbackPreview.preview, libraryDirectory: badLibrary, manifestURL: badManifest); check(false, "copy failure") }
catch { print("PASS: copy failure rejected") }
let firstID = rollbackPreview.preview.items[0].sourceID
let firstFolder = badLibrary.appendingPathComponent(SHA256.hash(data: Data(firstID.utf8)).map { String(format: "%02x", $0) }.joined())
check(!fm.fileExists(atPath: firstFolder.appendingPathComponent("v0001.wav").path), "partial import rolled back")
check((try Data(contentsOf: sentinel)) == Data("existing".utf8) && !fm.fileExists(atPath: badManifest.path), "existing library untouched")

var wave = Data()
func four(_ text: String) { wave.append(contentsOf: text.utf8) }
func u32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wave.append(contentsOf: $0) } }
func u16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wave.append(contentsOf: $0) } }
let sampleBytes: UInt32 = 8820
four("RIFF"); u32(36 + sampleBytes); four("WAVE"); four("fmt "); u32(16); u16(1); u16(1)
u32(44100); u32(88200); u16(2); u16(16); four("data"); u32(sampleBytes); wave.append(Data(repeating: 0, count: Int(sampleBytes)))
let validAudio = root.appendingPathComponent("valid.wav")
try wave.write(to: validAudio)
let validPreview = try service.scanAudio([validAudio], libraryDirectory: library, manifestURL: manifest)
_ = try service.apply(validPreview.preview, libraryDirectory: library, manifestURL: manifest)
let playable = try service.listAssets(manifestURL: manifest).first { $0.sourceID == validPreview.preview.items[0].sourceID }!
let player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: playable.versions.last!.diskPath))
check(player.duration > 0 && player.prepareToPlay() && player.play(), "valid imported WAV decodes and starts playback")
player.stop()
let prep = JianyingImportPreparation()
let chosen = try prep.prepare(assets: [playable, playable], libraryDirectory: library)
check(chosen.count == 1 && chosen[0].version == 1, "Jianying preparation checks and deduplicates")
do { _ = try prep.prepare(assets: [], libraryDirectory: library); check(false, "empty Jianying selection") }
catch { print("PASS: empty Jianying selection rejected") }
let external = LibraryAsset(sourceID: "external", metadata: playable.metadata, versions: [LibraryAssetVersion(version: 1, filename: validAudio.lastPathComponent, diskPath: validAudio.path, sizeBytes: Int64(wave.count), sha256: playable.versions[0].sha256, importedAt: "")], archivedAt: nil)
do { _ = try prep.prepare(assets: [external], libraryDirectory: library); check(false, "outside library") }
catch { print("PASS: outside library rejected") }
let importedPath = URL(fileURLWithPath: playable.versions.last!.diskPath)
try Data("tampered".utf8).write(to: importedPath)
do { _ = try prep.prepare(assets: [playable], libraryDirectory: library); check(false, "tampered audio") }
catch { print("PASS: modified library audio rejected") }
let link = library.appendingPathComponent("escape.wav")
try fm.createSymbolicLink(at: link, withDestinationURL: validAudio)
let escaped = LibraryAsset(sourceID: "escape", metadata: playable.metadata, versions: [LibraryAssetVersion(version: 1, filename: "escape.wav", diskPath: link.path, sizeBytes: Int64(wave.count), sha256: playable.versions[0].sha256, importedAt: "")], archivedAt: nil)
do { _ = try prep.prepare(assets: [escaped], libraryDirectory: library); check(false, "symlink escape") }
catch { print("PASS: symlink outside library rejected") }
