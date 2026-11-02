import Foundation
import CryptoKit

enum CacheServiceError: Error {
    case sourceMissing
    case checksumMismatch
}

struct CachedAsset {
    let fileURL: URL
    let sha256: String
    let byteCount: Int64
}

/// Safe first building block for the Mac agent.
/// Network download and Jianying UI automation are intentionally not wired yet.
struct CacheService {
    let rootURL: URL

    func cache(sourceURL: URL, expectedSHA256: String? = nil) throws -> CachedAsset {
        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            throw CacheServiceError.sourceMissing
        }

        let digest = try Self.sha256(fileURL: sourceURL)
        if let expectedSHA256, digest.lowercased() != expectedSHA256.lowercased() {
            throw CacheServiceError.checksumMismatch
        }

        let destinationFolder = rootURL.appendingPathComponent(digest, isDirectory: true)
        try FileManager.default.createDirectory(
            at: destinationFolder,
            withIntermediateDirectories: true
        )

        let safeName = sourceURL.lastPathComponent
        let destination = destinationFolder.appendingPathComponent(safeName)

        if !FileManager.default.fileExists(atPath: destination.path) {
            let partial = destinationFolder.appendingPathComponent(safeName + ".partial")
            try? FileManager.default.removeItem(at: partial)
            try FileManager.default.copyItem(at: sourceURL, to: partial)
            try FileManager.default.moveItem(at: partial, to: destination)
        }

        let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        return CachedAsset(fileURL: destination, sha256: digest, byteCount: size)
    }

    private static func sha256(fileURL: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }

        var hasher = SHA256()
        while true {
            guard let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty else {
                break
            }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
