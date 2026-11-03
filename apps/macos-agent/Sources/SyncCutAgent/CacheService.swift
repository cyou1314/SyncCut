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

/// Local content-addressed cache. Never trusts an existing cache entry without re-hashing it.
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

        let destination = destinationFolder.appendingPathComponent(sourceURL.lastPathComponent)
        if FileManager.default.fileExists(atPath: destination.path) {
            let cachedDigest = try Self.sha256(fileURL: destination)
            if cachedDigest == digest {
                let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
                let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
                return CachedAsset(fileURL: destination, sha256: digest, byteCount: size)
            }
            try Self.replaceCacheEntry(sourceURL: sourceURL, destinationURL: destination, expectedDigest: digest)
        } else {
            try Self.createCacheEntry(sourceURL: sourceURL, destinationURL: destination, expectedDigest: digest)
        }

        let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        return CachedAsset(fileURL: destination, sha256: digest, byteCount: size)
    }

    private static func createCacheEntry(sourceURL: URL, destinationURL: URL, expectedDigest: String) throws {
        let partial = destinationURL.deletingLastPathComponent()
            .appendingPathComponent(destinationURL.lastPathComponent + "." + UUID().uuidString + ".partial")
        defer { try? FileManager.default.removeItem(at: partial) }

        try FileManager.default.copyItem(at: sourceURL, to: partial)
        guard try sha256(fileURL: partial) == expectedDigest else {
            throw CacheServiceError.checksumMismatch
        }
        try FileManager.default.moveItem(at: partial, to: destinationURL)
    }

    private static func replaceCacheEntry(sourceURL: URL, destinationURL: URL, expectedDigest: String) throws {
        let partial = destinationURL.deletingLastPathComponent()
            .appendingPathComponent(destinationURL.lastPathComponent + "." + UUID().uuidString + ".partial")
        defer { try? FileManager.default.removeItem(at: partial) }

        try FileManager.default.copyItem(at: sourceURL, to: partial)
        guard try sha256(fileURL: partial) == expectedDigest else {
            throw CacheServiceError.checksumMismatch
        }
        _ = try FileManager.default.replaceItemAt(destinationURL, withItemAt: partial)
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
