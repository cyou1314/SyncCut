import Foundation
import Security

struct DevicePairingResponse: Decodable {
    let deviceId: String
    let tenantId: String
    let deviceName: String
    let deviceToken: String
    let pairedAt: String
}

struct DeviceIdentity: Decodable {
    let deviceId: String
    let tenantId: String
    let deviceName: String
    let appVersion: String?
    let macosVersion: String?
    let jianyingVersion: String?
}

private struct PairRequest: Encodable {
    let code: String
    let deviceName: String
    let appVersion: String
    let macosVersion: String
    let jianyingVersion: String?
}

private struct HeartbeatRequest: Encodable {
    let appVersion: String
    let macosVersion: String
    let jianyingVersion: String?
}

struct AgentJobAsset: Decodable {
    let assetVersionId: String
    let assetId: String
    let version: Int
    let name: String
    let kind: String
    let filename: String
    let mimeType: String?
    let sizeBytes: Int64
    let sha256: String
    let downloadUrl: URL
}

struct AgentJob: Decodable {
    let id: String
    let jobType: String
    let assets: [AgentJobAsset]
    let leaseSeconds: Int
}

struct AgentJobEnvelope: Decodable {
    let job: AgentJob?
}

struct AgentJobResult: Encodable {
    let downloaded: Int
    let verified: Int
    let reused: Int
}

private struct CompleteJobRequest: Encodable {
    let result: AgentJobResult
}

private struct FailJobRequest: Encodable {
    let error: String
}

private struct PairErrorResponse: Decodable {
    let error: String?
}

enum DevicePairingError: LocalizedError {
    case invalidServerURL
    case invalidPairingCode
    case httpStatus(Int, String?)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            return "云端 API 地址必须是 HTTPS 地址；仅 localhost、127.0.0.1 和 ::1 允许使用 HTTP。"
        case .invalidPairingCode:
            return "配对码格式不正确，请从 SyncCut 控制台重新复制。"
        case .httpStatus(let status, let code):
            switch code {
            case "invalid_or_expired_pairing_code": return "配对码无效、已使用或已过期，请重新生成。"
            case "pairing_rate_limited": return "配对尝试过于频繁，请稍后再试。"
            case "device_unauthorized": return "设备授权已撤销，请重新配对。"
            default: return "SyncCut 云端请求失败（HTTP \(status)）。"
            }
        }
    }
}

final class DeviceTokenStore {
    private let service = "com.synccut.agent.device"
    private let account = "device-token"

    func save(_ token: String) throws {
        guard let data = token.data(using: .utf8) else {
            throw DevicePairingError.invalidPairingCode
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [
                NSLocalizedDescriptionKey: "无法将设备凭证安全保存到 macOS 钥匙串（\(status)）。"
            ])
        }
    }

    func load() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [
                NSLocalizedDescriptionKey: "无法读取 macOS 钥匙串中的设备凭证（\(status)）。"
            ])
        }
        return token
    }

    func delete() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [
                NSLocalizedDescriptionKey: "无法删除 macOS 钥匙串中的设备凭证（\(status)）。"
            ])
        }
    }
}

final class DevicePairingService {
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(session: URLSession = .shared) {
        self.session = session
        encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
    }

    func pair(server: String, code: String, deviceName: String, appVersion: String, macosVersion: String) async throws -> DevicePairingResponse {
        let normalized = code.uppercased().filter { $0.isHexDigit }
        guard normalized.count == 16 else { throw DevicePairingError.invalidPairingCode }
        let body = PairRequest(
            code: normalized,
            deviceName: deviceName,
            appVersion: appVersion,
            macosVersion: macosVersion,
            jianyingVersion: nil
        )
        return try await send(
            server: server,
            path: "api/agent/pair",
            method: "POST",
            body: body,
            token: nil,
            response: DevicePairingResponse.self
        )
    }

    func currentDevice(server: String, token: String) async throws -> DeviceIdentity {
        try await send(
            server: server,
            path: "api/agent/me",
            method: "GET",
            body: Optional<HeartbeatRequest>.none,
            token: token,
            response: DeviceIdentity.self
        )
    }

    func heartbeat(server: String, token: String, appVersion: String, macosVersion: String) async throws {
        let body = HeartbeatRequest(appVersion: appVersion, macosVersion: macosVersion, jianyingVersion: nil)
        let _: [String: Bool] = try await send(
            server: server,
            path: "api/agent/heartbeat",
            method: "POST",
            body: body,
            token: token,
            response: [String: Bool].self
        )
    }

    func unpair(server: String, token: String) async throws {
        let _: [String: Bool] = try await send(
            server: server,
            path: "api/agent/unpair",
            method: "POST",
            body: Optional<HeartbeatRequest>.none,
            token: token,
            response: [String: Bool].self
        )
    }

    func nextJob(server: String, token: String) async throws -> AgentJob? {
        let envelope: AgentJobEnvelope = try await send(
            server: server,
            path: "api/agent/jobs/next",
            method: "GET",
            body: Optional<HeartbeatRequest>.none,
            token: token,
            response: AgentJobEnvelope.self
        )
        return envelope.job
    }

    func heartbeatJob(server: String, token: String, jobId: String) async throws {
        let _: [String: Bool] = try await send(
            server: server,
            path: "api/agent/jobs/\\(jobId)/heartbeat",
            method: "POST",
            body: Optional<HeartbeatRequest>.none,
            token: token,
            response: [String: Bool].self
        )
    }

    func completeJob(server: String, token: String, jobId: String, result: AgentJobResult) async throws {
        let _: [String: Bool] = try await send(
            server: server,
            path: "api/agent/jobs/\\(jobId)/complete",
            method: "POST",
            body: CompleteJobRequest(result: result),
            token: token,
            response: [String: Bool].self
        )
    }

    func failJob(server: String, token: String, jobId: String, message: String) async throws {
        let _: [String: Bool] = try await send(
            server: server,
            path: "api/agent/jobs/\\(jobId)/fail",
            method: "POST",
            body: FailJobRequest(error: String(message.prefix(1000))),
            token: token,
            response: [String: Bool].self
        )
    }

    func downloadAsset(from url: URL) async throws -> URL {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 120
        let (fileURL, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw DevicePairingError.httpStatus(status, nil)
        }
        return fileURL
    }

    private func baseURL(_ raw: String) throws -> URL {
        guard var components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else {
            throw DevicePairingError.invalidServerURL
        }
        let loopback = ["localhost", "127.0.0.1", "::1"].contains(host)
        guard scheme == "https" || (scheme == "http" && loopback) else {
            throw DevicePairingError.invalidServerURL
        }
        components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = components.url else { throw DevicePairingError.invalidServerURL }
        return url
    }

    private func send<Body: Encodable, Response: Decodable>(
        server: String,
        path: String,
        method: String,
        body: Body?,
        token: String?,
        response responseType: Response.Type
    ) async throws -> Response {
        let root = try baseURL(server)
        let url = root.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw DevicePairingError.httpStatus(0, nil)
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(PairErrorResponse.self, from: data)
            throw DevicePairingError.httpStatus(http.statusCode, error?.error)
        }
        return try decoder.decode(Response.self, from: data)
    }
}
