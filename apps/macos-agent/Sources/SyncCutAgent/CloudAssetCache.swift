import Foundation
import CryptoKit

struct CloudCachedAsset: Codable, Identifiable {
    var id: String { assetVersionId }
    let assetVersionId: String
    let assetId: String
    let version: Int
    let name: String
    let kind: String
    let filename: String
    let mimeType: String?
    let sizeBytes: Int64
    let sha256: String
    let relativePath: String
    let cachedAt: Date
}

private struct CloudCacheManifest: Codable {
    var schemaVersion: Int = 1
    var updatedAt: Date = Date()
    var assets: [CloudCachedAsset] = []
}

struct CloudAssetCacheResult {
    let cachedAsset: CloudCachedAsset
    let reusedExistingFile: Bool
}

enum CloudAssetCacheError: LocalizedError {
    case invalidDownloadURL
    case assetTooLarge(Int64)
    case sizeMismatch(expected: Int64, actual: Int64)
    case checksumMismatch

    var errorDescription: String? {
        switch self {
        case .invalidDownloadURL:
            return "云端返回的素材下载地址不安全。"
        case .assetTooLarge(let size):
            return "素材超过本地同步上限：\(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))。"
        case .sizeMismatch(let expected, let actual):
            return "下载文件大小不一致（预期 \(expected) 字节，实际 \(actual) 字节）。"
        case .checksumMismatch:
            return "下载文件 SHA-256 校验失败，文件未写入素材缓存。"
        }
    }
}

final class CloudAssetCache {
    private let directory: URL
    private let manifestURL: URL
    private let fileManager: FileManager
    private let maxAssetBytes: Int64 = 512 * 1024 * 1024

    init(directory: URL, fileManager: FileManager = .default) {
        self.directory = directory
        self.manifestURL = directory.appendingPathComponent("manifest.json")
        self.fileManager = fileManager
    }

    func cache(_ asset: AgentJobAsset, downloadedURL: URL) throws -> CloudAssetCacheResult {
        try validateDownloadURL(asset.downloadUrl)
        let attributes = try fileManager.attributesOfItem(atPath: downloadedURL.path)
        let actualSize = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        guard actualSize <= maxAssetBytes else { throw CloudAssetCacheError.assetTooLarge(actualSize) }
        guard actualSize == asset.sizeBytes else {
            throw CloudAssetCacheError.sizeMismatch(expected: asset.sizeBytes, actual: actualSize)
        }
        let digest = try Self.sha256(of: downloadedURL)
        guard digest.caseInsensitiveCompare(asset.sha256) == .orderedSame else {
            throw CloudAssetCacheError.checksumMismatch
        }

        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let ext = safeExtension(asset.filename)
        let filename = "\(digest).\(ext)"
        let destination = directory.appendingPathComponent(filename)
        var reused = false

        if fileManager.fileExists(atPath: destination.path) {
            let existingSize = ((try? fileManager.attributesOfItem(atPath: destination.path)[.size]) as? NSNumber)?.int64Value ?? -1
            let existingHash = try? Self.sha256(of: destination)
            if existingSize == actualSize && existingHash?.caseInsensitiveCompare(digest) == .orderedSame {
                reused = true
                try? fileManager.removeItem(at: downloadedURL)
            } else {
                try fileManager.removeItem(at: destination)
                try fileManager.moveItem(at: downloadedURL, to: destination)
            }
        } else {
            try fileManager.moveItem(at: downloadedURL, to: destination)
        }

        let entry = CloudCachedAsset(
            assetVersionId: asset.assetVersionId,
            assetId: asset.assetId,
            version: asset.version,
            name: asset.name,
            kind: asset.kind,
            filename: asset.filename,
            mimeType: asset.mimeType,
            sizeBytes: actualSize,
            sha256: digest,
            relativePath: filename,
            cachedAt: Date()
        )
        try upsertManifest(entry)
        return CloudAssetCacheResult(cachedAsset: entry, reusedExistingFile: reused)
    }

    func cachedAssets() throws -> [CloudCachedAsset] {
        let manifest = try loadManifest()
        return manifest.assets
    }

    private func validateDownloadURL(_ url: URL) throws {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              url.user == nil, url.password == nil,
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)) else {
            throw CloudAssetCacheError.invalidDownloadURL
        }
    }

    private func safeExtension(_ filename: String) -> String {
        let ext = URL(fileURLWithPath: filename).pathExtension.lowercased()
        guard !ext.isEmpty, ext.count <= 10, ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else {
            return "bin"
        }
        return ext
    }

    private func loadManifest() throws -> CloudCacheManifest {
        guard fileManager.fileExists(atPath: manifestURL.path) else { return CloudCacheManifest() }
        let data = try Data(contentsOf: manifestURL)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(CloudCacheManifest.self, from: data)
    }

    private func upsertManifest(_ entry: CloudCachedAsset) throws {
        var manifest = try loadManifest()
        manifest.assets.removeAll { $0.assetVersionId == entry.assetVersionId }
        manifest.assets.append(entry)
        manifest.assets.sort { $0.cachedAt > $1.cachedAt }
        manifest.updatedAt = Date()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(manifest)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: manifestURL, options: .atomic)
    }

    private static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

struct CloudJobRunSummary {
    let jobId: String
    let assetCount: Int
    let downloadedCount: Int
    let reusedCount: Int
}

final class AgentJobRunner {
    private let service: DevicePairingService
    private let cache: CloudAssetCache

    init(service: DevicePairingService, cache: CloudAssetCache) {
        self.service = service
        self.cache = cache
    }

    func runNext(server: String, token: String) async throws -> CloudJobRunSummary? {
        guard let job = try await service.nextJob(server: server, token: token) else { return nil }
        guard job.jobType == "sync_assets", !job.assets.isEmpty else {
            try? await service.failJob(server: server, token: token, jobId: job.id, message: "Unsupported or empty device task.")
            throw NSError(domain: "SyncCut.AgentJob", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "收到不支持的云端任务类型或空素材任务。"
            ])
        }

        let heartbeat = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                if Task.isCancelled { break }
                try? await service.heartbeatJob(server: server, token: token, jobId: job.id)
            }
        }
        defer { heartbeat.cancel() }

        do {
            var downloaded = 0
            var reused = 0
            for asset in job.assets {
                let temporary = try await service.downloadAsset(from: asset.downloadUrl)
                let result = try cache.cache(asset, downloadedURL: temporary)
                downloaded += 1
                if result.reusedExistingFile { reused += 1 }
            }
            try await service.completeJob(
                server: server,
                token: token,
                jobId: job.id,
                result: AgentJobResult(downloaded: downloaded, verified: downloaded, reused: reused)
            )
            return CloudJobRunSummary(jobId: job.id, assetCount: job.assets.count, downloadedCount: downloaded, reusedCount: reused)
        } catch {
            try? await service.failJob(server: server, token: token, jobId: job.id, message: error.localizedDescription)
            throw error
        }
    }
}
