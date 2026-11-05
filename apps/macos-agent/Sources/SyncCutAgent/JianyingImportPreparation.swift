import Foundation
import CryptoKit

struct JianyingImportFile {
    let assetID: String
    let name: String
    let version: Int
    let url: URL
}

enum JianyingPreparationError: LocalizedError {
    case emptySelection
    case missingVersion(String)
    case outsideLibrary(String)
    case unreadable(String)
    case changed(String)

    var errorDescription: String? {
        switch self {
        case .emptySelection: return "请先选择要导入剪映的素材。"
        case .missingVersion(let name): return "素材没有可导入的音频版本：\(name)"
        case .outsideLibrary(let name): return "素材文件不在已选择的素材库中：\(name)"
        case .unreadable(let name): return "无法读取素材：\(name)"
        case .changed(let name): return "素材文件与导入记录不一致：\(name)"
        }
    }
}

struct JianyingImportPreparation {
    func prepare(assets: [LibraryAsset], libraryDirectory: URL) throws -> [JianyingImportFile] {
        guard !assets.isEmpty else { throw JianyingPreparationError.emptySelection }
        let root = libraryDirectory.standardizedFileURL.resolvingSymlinksInPath().path
        var seen = Set<String>()
        var files: [JianyingImportFile] = []
        for asset in assets where seen.insert(asset.sourceID).inserted {
            guard let version = asset.versions.last else { throw JianyingPreparationError.missingVersion(asset.metadata.name) }
            let url = URL(fileURLWithPath: version.diskPath).standardizedFileURL.resolvingSymlinksInPath()
            guard url.path.hasPrefix(root + "/") else { throw JianyingPreparationError.outsideLibrary(asset.metadata.name) }
            do {
                let attributes = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                guard attributes.isRegularFile == true, Int64(attributes.fileSize ?? -1) == version.sizeBytes else {
                    throw JianyingPreparationError.changed(asset.metadata.name)
                }
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                var hash = SHA256()
                while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { hash.update(data: data) }
                let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
                guard digest == version.sha256 else { throw JianyingPreparationError.changed(asset.metadata.name) }
                files.append(.init(assetID: asset.sourceID, name: asset.metadata.name, version: version.version, url: url))
            } catch let error as JianyingPreparationError { throw error }
            catch { throw JianyingPreparationError.unreadable(asset.metadata.name) }
        }
        return files
    }
}
