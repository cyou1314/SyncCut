import Foundation
import CryptoKit

struct LocalImportPreview {
    struct Item {
        let sourceID: String
        let metadata: AssetMetadata
        let sourceURL: URL
        let byteCount: Int64
        let sha256: String
        let hadPreviousVersion: Bool
    }
    struct RowError: Identifiable {
        let id = UUID()
        let row: Int
        let message: String
    }
    let items: [Item]
    let errors: [RowError]
    var readyCount: Int { items.count }
    var newCount: Int { items.filter { !$0.hadPreviousVersion }.count }
    var existingCount: Int { items.filter(\.hadPreviousVersion).count }
}

struct AssetMetadata: Codable, Equatable {
    struct Timing: Codable, Equatable {
        var start: Double?
        var inPoint: Double?
        var outPoint: Double?
        var track: String?
        var volume: Double?
        var fadeIn: Double?
        var fadeOut: Double?
    }
    var name: String
    var kind: String
    var project: String
    var episode: String
    var scene: String
    var shot: String
    var tags: [String]
    var notes: String
    var timing: Timing
}

private struct AssetVersion: Codable {
    var version: Int
    var filename: String
    var diskPath: String
    var sizeBytes: Int64
    var sha256: String
    var importedAt: String
}
private struct AssetRecord: Codable {
    var sourceId: String
    var sourceIdIsDerived: Bool
    var metadata: AssetMetadata
    var versions: [AssetVersion]
}
private struct AssetManifest: Codable {
    var version: Int
    var assets: [AssetRecord]
    var updatedAt: String?
}

enum LocalImportError: LocalizedError {
    case invalidCSV(String)
    case invalidManifest
    case unresolvedRows
    case sourceChanged(String)

    var errorDescription: String? {
        switch self {
        case .invalidCSV(let message): return message
        case .invalidManifest: return "现有素材清单格式无法识别，未修改任何文件。"
        case .unresolvedRows: return "存在未解决的表格错误，不能导入。"
        case .sourceChanged(let name): return "素材在预览后发生变化：\(name)。请重新预览。"
        }
    }
}

struct LocalImportService {
    private let audioExtensions: Set<String> = ["mp3", "wav", "m4a", "aac", "aiff", "aif", "flac", "ogg", "opus"]

    func preview(tableURL: URL, audioDirectory: URL, manifestURL: URL) throws -> LocalImportPreview {
        let data = try Data(contentsOf: tableURL)
        guard data.count <= 32 * 1024 * 1024,
              let csv = String(data: data, encoding: .utf8) else {
            throw LocalImportError.invalidCSV("CSV 超过 32 MiB 或不是有效 UTF-8 文件。")
        }
        let rows = try parseCSV(csv)
        guard let headers = rows.first, !headers.isEmpty else {
            throw LocalImportError.invalidCSV("CSV 没有表头或没有数据。")
        }
        let headerNames = headers.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\u{FEFF}", with: "") }
        guard !headerNames.contains(where: \.isEmpty), Set(headerNames).count == headerNames.count else {
            throw LocalImportError.invalidCSV("CSV 表头存在空列名或重复列名。")
        }

        let existing = try loadManifest(manifestURL)
        let existingByID = Dictionary(uniqueKeysWithValues: existing.assets.map { ($0.sourceId, $0) })
        let files = try audioFiles(in: audioDirectory)
        var byName: [String: [URL]] = [:]
        for file in files { byName[file.lastPathComponent, default: []].append(file) }

        var items: [LocalImportPreview.Item] = []
        var errors: [LocalImportPreview.RowError] = []
        var seen = Set<String>()

        for (offset, values) in rows.dropFirst().enumerated() {
            if values.allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { continue }
            let rowNumber = offset + 2
            let record = Dictionary(uniqueKeysWithValues: headerNames.enumerated().map { index, key in
                (key, index < values.count ? values[index].trimmingCharacters(in: .whitespacesAndNewlines) : "")
            })
            do {
                func value(_ keys: [String]) -> String {
                    for key in keys where !(record[key] ?? "").isEmpty { return record[key] ?? "" }
                    return ""
                }
                let name = value(["素材名称", "name", "名称"])
                let kindRaw = value(["素材类型", "kind", "类型"])
                let kindMap = ["音乐": "music", "music": "music", "音效": "sfx", "sfx": "sfx", "配音": "voice", "voice": "voice", "环境音": "ambience", "ambience": "ambience"]
                guard !name.isEmpty, let kind = kindMap[kindRaw.lowercased()] else {
                    throw LocalImportError.invalidCSV("素材名称或素材类型缺失/不支持。")
                }
                let attachment = value(["音频附件", "附件", "filename", "文件名", "audio_file"])
                guard !attachment.isEmpty else { throw LocalImportError.invalidCSV("未填写音频附件文件名。") }
                let matches = byName[(attachment as NSString).lastPathComponent] ?? []
                guard matches.count == 1, let source = matches.first else {
                    throw LocalImportError.invalidCSV(matches.isEmpty ? "找不到对应音频文件。" : "音频文件名重复，无法唯一匹配。")
                }
                func number(_ keys: [String]) throws -> Double? {
                    let raw = value(keys)
                    guard !raw.isEmpty else { return nil }
                    guard let number = Double(raw), number.isFinite, number >= 0 else {
                        throw LocalImportError.invalidCSV("时间或数值字段必须为非负数字。")
                    }
                    return number
                }
                let trackValue = value(["目标音轨", "track"])
                if !trackValue.isEmpty && !["A1", "A2", "A3", "A4"].contains(trackValue) {
                    throw LocalImportError.invalidCSV("目标音轨必须为 A1-A4。")
                }
                let inPoint = try number(["素材入点", "inPoint", "in_point"])
                let outPoint = try number(["素材出点", "outPoint", "out_point"])
                if let start = inPoint, let end = outPoint, end <= start {
                    throw LocalImportError.invalidCSV("素材出点必须大于素材入点。")
                }
                let metadata = AssetMetadata(
                    name: name, kind: kind,
                    project: value(["项目名称", "project"]),
                    episode: value(["集数", "episode"]),
                    scene: value(["场景", "scene"]),
                    shot: value(["镜头编号", "shot", "shot_id"]),
                    tags: value(["标签", "tags"]).split(whereSeparator: { ",;，；".contains($0) }).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty },
                    notes: value(["备注", "notes"]),
                    timing: .init(
                        start: try number(["开始时间", "start"]), inPoint: inPoint, outPoint: outPoint,
                        track: trackValue.isEmpty ? nil : trackValue,
                        volume: try number(["音量", "volume"]),
                        fadeIn: try number(["淡入", "fadeIn", "fade_in"]),
                        fadeOut: try number(["淡出", "fadeOut", "fade_out"])
                    )
                )
                let explicitID = value(["SyncCut ID", "sync_cut_id", "record_id", "记录ID"])
                let identity = explicitID.isEmpty
                    ? [metadata.project, metadata.episode, metadata.scene, metadata.shot, metadata.name].joined(separator: "\u{1F}").lowercased()
                    : explicitID
                let sourceID = explicitID.isEmpty ? "derived_" + sha256(Data(identity.utf8)) : explicitID
                guard seen.insert(sourceID).inserted else { throw LocalImportError.invalidCSV("表格中存在重复素材 ID。") }
                let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
                let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
                items.append(.init(sourceID: sourceID, metadata: metadata, sourceURL: source, byteCount: size,
                                   sha256: try sha256(fileURL: source), hadPreviousVersion: existingByID[sourceID] != nil))
            } catch {
                errors.append(.init(row: rowNumber, message: error.localizedDescription))
            }
        }
        return .init(items: items, errors: errors)
    }

    func apply(_ preview: LocalImportPreview, libraryDirectory: URL, manifestURL: URL) throws -> (added: Int, updated: Int, unchanged: Int) {
        guard preview.errors.isEmpty else { throw LocalImportError.unresolvedRows }
        var manifest = try loadManifest(manifestURL)
        var records = Dictionary(uniqueKeysWithValues: manifest.assets.map { ($0.sourceId, $0) })
        var added = 0, updated = 0, unchanged = 0

        for item in preview.items {
            let old = records[item.sourceID]
            let currentDigest = try sha256(fileURL: item.sourceURL)
            guard currentDigest == item.sha256 else { throw LocalImportError.sourceChanged(item.sourceURL.lastPathComponent) }
            if let old, old.versions.last?.sha256 == item.sha256 {
                records[item.sourceID] = .init(sourceId: old.sourceId, sourceIdIsDerived: old.sourceIdIsDerived,
                                               metadata: item.metadata, versions: old.versions)
                unchanged += 1
                continue
            }
            let version = (old?.versions.count ?? 0) + 1
            let folder = libraryDirectory.appendingPathComponent(sha256(Data(item.sourceID.utf8)), isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let ext = item.sourceURL.pathExtension.lowercased()
            let filename = "v" + String(format: "%04d", version) + (ext.isEmpty ? "" : "." + ext)
            let destination = folder.appendingPathComponent(filename)
            let temporary = folder.appendingPathComponent(filename + "." + UUID().uuidString + ".partial")
            do {
                try FileManager.default.copyItem(at: item.sourceURL, to: temporary)
                guard try sha256(fileURL: temporary) == item.sha256 else { throw LocalImportError.sourceChanged(item.sourceURL.lastPathComponent) }
                try FileManager.default.moveItem(at: temporary, to: destination)
            } catch {
                try? FileManager.default.removeItem(at: temporary)
                throw error
            }
            let record = AssetRecord(
                sourceId: item.sourceID, sourceIdIsDerived: item.sourceID.hasPrefix("derived_"),
                metadata: item.metadata,
                versions: (old?.versions ?? []) + [.init(
                    version: version, filename: filename, diskPath: destination.path,
                    sizeBytes: item.byteCount, sha256: item.sha256,
                    importedAt: ISO8601DateFormatter().string(from: Date())
                )]
            )
            records[item.sourceID] = record
            if old == nil { added += 1 } else { updated += 1 }
        }

        manifest.assets = records.values.sorted { $0.sourceId < $1.sourceId }
        manifest.updatedAt = ISO8601DateFormatter().string(from: Date())
        try FileManager.default.createDirectory(at: libraryDirectory, withIntermediateDirectories: true)
        let data = try JSONEncoder.pretty.encode(manifest)
        try data.write(to: manifestURL, options: .atomic)
        return (added, updated, unchanged)
    }

    private func loadManifest(_ url: URL) throws -> AssetManifest {
        guard FileManager.default.fileExists(atPath: url.path) else { return .init(version: 1, assets: [], updatedAt: nil) }
        do {
            let manifest = try JSONDecoder().decode(AssetManifest.self, from: Data(contentsOf: url))
            guard manifest.version == 1 else { throw LocalImportError.invalidManifest }
            return manifest
        } catch { throw LocalImportError.invalidManifest }
    }

    private func audioFiles(in directory: URL) throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else {
            throw LocalImportError.invalidCSV("无法读取音频目录。")
        }
        var result: [URL] = []
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            if values.isSymbolicLink == true { enumerator.skipDescendants(); continue }
            if values.isRegularFile == true && audioExtensions.contains(url.pathExtension.lowercased()) { result.append(url) }
        }
        return result.sorted { $0.path < $1.path }
    }

    private func parseCSV(_ source: String) throws -> [[String]] {
        var rows: [[String]] = [], row: [String] = [], cell = ""
        var quoted = false
        let chars = Array(source)
        var index = 0
        while index < chars.count {
            let char = chars[index]
            if quoted {
                if char == "\"" && index + 1 < chars.count && chars[index + 1] == "\"" {
                    cell.append("\""); index += 1
                } else if char == "\"" { quoted = false }
                else { cell.append(char) }
            } else if char == "\"" && cell.isEmpty { quoted = true }
            else if char == "," { row.append(cell); cell = "" }
            else if char == "\n" || char == "\r" {
                if char == "\r" && index + 1 < chars.count && chars[index + 1] == "\n" { index += 1 }
                row.append(cell)
                if row.contains(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { rows.append(row) }
                row = []; cell = ""
            } else { cell.append(char) }
            index += 1
        }
        guard !quoted else { throw LocalImportError.invalidCSV("CSV 引号没有闭合。") }
        if !cell.isEmpty || !row.isEmpty {
            row.append(cell)
            if row.contains(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { rows.append(row) }
        }
        return rows
    }

    private func sha256(fileURL: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { hasher.update(data: data) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

private extension JSONEncoder {
    static var pretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}
