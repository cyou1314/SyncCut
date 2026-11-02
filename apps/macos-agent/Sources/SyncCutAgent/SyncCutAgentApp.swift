import SwiftUI
import AppKit

@main
struct SyncCutAgentApp: App {
    @StateObject private var model = AgentViewModel()

    var body: some Scene {
        MenuBarExtra("SyncCut", systemImage: "waveform") {
            AgentMenuView(model: model)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AgentViewModel: ObservableObject {
    @Published var paired = false
    @Published var status = "尚未配对"
    @Published var cachePath = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)
        .first?
        .appendingPathComponent("SyncCut/Cache", isDirectory: true).path ?? "不可用"

    func prepareCache() {
        do {
            let url = URL(fileURLWithPath: cachePath, isDirectory: true)
            try FileManager.default.createDirectory(
                at: url, withIntermediateDirectories: true
            )
            status = "本地缓存目录已准备"
        } catch {
            status = "缓存目录创建失败：\(error.localizedDescription)"
        }
    }

    func openCache() {
        let url = URL(fileURLWithPath: cachePath, isDirectory: true)
        NSWorkspace.shared.open(url)
    }
}

struct AgentMenuView: View {
    @ObservedObject var model: AgentViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "waveform").foregroundStyle(.indigo)
                Text("SyncCut 助手").font(.headline)
                Spacer()
                Circle().fill(model.paired ? .green : .orange).frame(width: 7, height: 7)
            }
            Text(model.status).font(.caption).foregroundStyle(.secondary)
            Divider()
            Text("本地缓存目录").font(.caption.weight(.semibold))
            Text(model.cachePath)
                .font(.system(size: 10, design: .monospaced))
                .textSelection(.enabled)
            HStack {
                Button("准备缓存目录") { model.prepareCache() }
                Button("打开目录") { model.openCache() }
            }
            Divider()
            Text("剪映连接：尚未实现").font(.caption).foregroundStyle(.secondary)
            Button("退出 SyncCut") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
        .padding(14)
        .frame(width: 300)
    }
}
