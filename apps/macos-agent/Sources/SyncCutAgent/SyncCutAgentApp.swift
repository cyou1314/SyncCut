import SwiftUI
import AppKit
import UniformTypeIdentifiers

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
    @Published var tableURL: URL?
    @Published var audioURL: URL?
    @Published var libraryURL: URL?
    @Published var preview: LocalImportPreview?
    @Published var errors: [String] = []
    @Published var isWorking = false
    @Published var resultText = ""
    @Published var picker: PickerTarget?
    private let importer = LocalImportService()

    enum PickerTarget: String, Identifiable {
        case table, audio, library
        var id: String { rawValue }
    }

    var manifestURL: URL? { libraryURL?.appendingPathComponent("manifest.json") }
    var canPreview: Bool { tableURL != nil && audioURL != nil && libraryURL != nil && !isWorking }
    var canImport: Bool { preview != nil && preview?.errors.isEmpty == true && !isWorking }

    func prepareCache() {
        do {
            let url = URL(fileURLWithPath: cachePath, isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            status = "本地缓存目录已准备"
        } catch { status = "缓存目录创建失败：\(error.localizedDescription)" }
    }

    func openCache() {
        NSWorkspace.shared.open(URL(fileURLWithPath: cachePath, isDirectory: true))
    }

    func runPreview() {
        guard let tableURL, let audioURL, let manifestURL else { return }
        isWorking = true; preview = nil; errors = []; resultText = ""
        let libraryURL = self.libraryURL!
        Task.detached(priority: .userInitiated) {
            let scopedURLs = [tableURL, audioURL, libraryURL]
            let accessGranted = scopedURLs.map { $0.startAccessingSecurityScopedResource() }
            defer {
                for (url, granted) in zip(scopedURLs, accessGranted) where granted {
                    url.stopAccessingSecurityScopedResource()
                }
            }
            do {
                let value = try self.importer.preview(tableURL: tableURL, audioDirectory: audioURL, manifestURL: manifestURL)
                await MainActor.run { self.preview = value; self.isWorking = false }
            } catch {
                await MainActor.run { self.errors = [error.localizedDescription]; self.isWorking = false }
            }
        }
    }

    func applyImport() {
        guard let preview, let libraryURL, let manifestURL else { return }
        isWorking = true; errors = []
        Task.detached(priority: .userInitiated) {
            let scopedURLs = [libraryURL]
            let accessGranted = scopedURLs.map { $0.startAccessingSecurityScopedResource() }
            defer {
                for (url, granted) in zip(scopedURLs, accessGranted) where granted {
                    url.stopAccessingSecurityScopedResource()
                }
            }
            do {
                let result = try self.importer.apply(preview, libraryDirectory: libraryURL, manifestURL: manifestURL)
                await MainActor.run {
                    self.resultText = "导入完成：新增 \(result.added) · 更新 \(result.updated) · 未变更 \(result.unchanged)"
                    self.preview = nil
                    self.isWorking = false
                }
            } catch {
                await MainActor.run { self.errors = [error.localizedDescription]; self.isWorking = false }
            }
        }
    }

    func choose(_ target: PickerTarget) {
        picker = target
    }

    func accept(_ url: URL, for target: PickerTarget) {
        switch target {
        case .table: tableURL = url; preview = nil
        case .audio: audioURL = url; preview = nil
        case .library: libraryURL = url; preview = nil
        }
    }
}

struct AgentMenuView: View {
    @ObservedObject var model: AgentViewModel
    @State private var showImporter = false

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                Image(systemName: "waveform").foregroundStyle(.indigo)
                Text("SyncCut 助手").font(.headline)
                Spacer()
                Circle().fill(model.paired ? .green : .orange).frame(width: 7, height: 7)
            }
            Text(model.status).font(.caption).foregroundStyle(.secondary)
            Divider()
            HStack {
                Text("本地素材导入").font(.subheadline.weight(.semibold))
                Spacer()
                if model.isWorking { ProgressView().controlSize(.small) }
            }
            pickerRow("素材清单", detail: model.tableURL?.lastPathComponent ?? "选择 CSV 文件", icon: "tablecells", action: { model.choose(.table) })
            pickerRow("音频目录", detail: model.audioURL?.lastPathComponent ?? "选择音频文件夹", icon: "folder", action: { model.choose(.audio) })
            pickerRow("素材库", detail: model.libraryURL?.path ?? "选择保存位置", icon: "externaldrive", action: { model.choose(.library) })
            Button { model.runPreview() } label: {
                Label("检查并预览", systemImage: "doc.magnifyingglass").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!model.canPreview)
            if let preview = model.preview {
                Divider()
                HStack(spacing: 14) {
                    metric("可导入", value: "\(preview.readyCount)")
                    metric("新素材", value: "\(preview.newCount)")
                    metric("已有", value: "\(preview.existingCount)")
                    metric("错误", value: "\(preview.errors.count)")
                }
                if !preview.errors.isEmpty {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(preview.errors) { error in
                                Text("第 \(error.row) 行：\(error.message)")
                                    .font(.caption).foregroundStyle(.red)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(maxHeight: 110)
                } else {
                    Button { model.applyImport() } label: {
                        Label("确认导入", systemImage: "square.and.arrow.down").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    .disabled(!model.canImport)
                }
            }
            if !model.errors.isEmpty {
                ForEach(model.errors, id: \.self) { error in
                    Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
            }
            if !model.resultText.isEmpty {
                Text(model.resultText).font(.caption).foregroundStyle(.green)
            }
            Divider()
            Text("本地缓存").font(.caption.weight(.semibold))
            HStack {
                Button("准备缓存") { model.prepareCache() }
                Button("打开缓存目录") { model.openCache() }
            }
            Button("退出 SyncCut") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
        .padding(14)
        .frame(width: 360)
        .fileImporter(
            isPresented: Binding(get: { model.picker != nil }, set: { if !$0 { model.picker = nil } }),
            allowedContentTypes: allowedTypes,
            allowsMultipleSelection: false
        ) { result in
            guard let target = model.picker else { return }
            model.picker = nil
            do {
                guard let url = try result.get().first else { return }
                model.accept(url, for: target)
            } catch { model.errors = [error.localizedDescription] }
        }
    }

    private var allowedTypes: [UTType] {
        switch model.picker {
        case .table: return [UTType(filenameExtension: "csv") ?? .commaSeparatedText]
        case .audio, .library: return [.folder]
        case .none: return [.item]
        }
    }

    private func pickerRow(_ title: String, detail: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon).frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.caption.weight(.semibold))
                    Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func metric(_ title: String, value: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.title3.weight(.semibold).monospacedDigit())
            Text(title).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}
