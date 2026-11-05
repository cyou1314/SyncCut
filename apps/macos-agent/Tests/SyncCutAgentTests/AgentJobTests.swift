import Foundation
import XCTest
@testable import SyncCutAgent

private final class StubURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.requestHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class AgentJobTests: XCTestCase {
    func testFailJobInterpolatesJobIdIntoRequestPath() async throws {
        let expectedPath = "/api/agent/jobs/job-123/fail"
        StubURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.url?.path, expectedPath)
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, Data(#"{"ok":true,"retried":false}"#.utf8))
        }
        defer { StubURLProtocol.requestHandler = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }

        let service = DevicePairingService(session: session)
        try await service.failJob(
            server: "https://sync.example.test",
            token: "device-token",
            jobId: "job-123",
            message: "simulated download failure"
        )
    }

    func testCloudJobCompletionMessageInterpolatesCounts() {
        XCTAssertEqual(
            cloudJobCompletionMessage(assetCount: 3, reusedCount: 1),
            "任务完成：3 个素材已下载并通过 SHA-256 校验；1 个文件复用了本地缓存。素材已放入 CloudAssets，剪映导入将在下一阶段接入。"
        )
    }
}
