import SwiftUI
import AppKit
import AVFoundation
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

    @Published var activeTab = "导入"
    @Published var tableURL: URL?
    @Published var audioURL: URL?
    @Published var libraryURL: URL?
    @Published var preview: LocalImportPreview?
    @Published var errors: [String] = []
    @Published var isWorking = false
    @Published var resultText = ""
    @Published var picker: PickerTarget?

    @Published var libraryAssets: [LibraryAsset] = []
    @Published var searchText = ""
    @Published var kindFilter = "全部"
    @Published var showArchived = false
    @Published var selectedAssetID: String?
    @Published private(set) var playingVersionKey: String?

    private let importer = LocalImportService()
    private let libraryBookmarkKey = "SyncCut.libraryBookmark.v1"
    private var audioPlayer: AVAudioPlayer?
    private var audioAccessGranted = false

    enum PickerTarget: String, Identifiable {
        case table, audio, library
        var id: String { rawValue }
    }

    init() {
        restoreLibraryBookmark()
    }

    var manifestURL: URL? { libraryURL?.appendingPathComponent("manifest.json") }
    var canPreview: Bool { tableURL != nil && audioURL != nil && libraryURL != nil && !isWorking }
    var canImport: Bool { preview != nil && preview?.errors.isEmpty == true && !isWorking }

    var visibleAssets: [LibraryAsset] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return libraryAssets.filter { asset in
            guard asset.isArchived == showArchived else { return false }
            let kindMatches = kindFilter == "全部" || asset.metadata.kind == Self.kindCode(kindFilter)
            guard kindMatches else { return false }
            guard !query.isEmpty else { return true }
            let searchable = [
                asset.metadata.name, asset.metadata.project, asset.metadata.episode,
                asset.metadata.scene, asset.metadata.shot, asset.metadata.notes,
                asset.metadata.tags.joined(separator: " ")
            ].joined(separator: " ").localizedLowercase
            return searchable.contains(query.localizedLowercase)
        }
    }

    var selectedAsset: LibraryAsset? {
        guard let selectedAssetID else { return nil }
        return libraryAssets.first { $0.sourceID == selectedAssetID && $0.isArchived == showArchived }
    }

    func prepareCache() {
        do {
            let url = URL(fileURLWithPath: cachePath, isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            status = "本地缓存目录已准备"
        } catch {
            status = "缓存目录创建失败：\(error.localizedDescription)"
        }
    }

    func openCache() {
        NSWorkspace.shared.open(URL(fileURLWithPath: cachePath, isDirectory: true))
    }

    func openLibrary() {
        guard let libraryURL else { return }
        NSWorkspace.shared.open(libraryURL)
    }

    func revealVersion(_ version: LibraryAssetVersion) {
        let url = URL(fileURLWithPath: version.diskPath)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func refreshLibrary() {
        guard let libraryURL, let manifestURL else {
            libraryAssets = []
            return
        }
        guard FileManager.default.fileExists(atPath: libraryURL.path) else {
            libraryAssets = []
            errors = ["上次选择的素材库目录已不存在，请重新选择。"]
            return
        }
        let granted = libraryURL.startAccessingSecurityScopedResource()
        defer { if granted { libraryURL.stopAccessingSecurityScopedResource() } }
        do {
            libraryAssets = try importer.listAssets(manifestURL: manifestURL)
            if let selectedAssetID, !libraryAssets.contains(where: { $0.sourceID == selectedAssetID }) {
                self.selectedAssetID = nil
            }
        } catch {
            errors = [error.localizedDescription]
        }
    }

    func runPreview() {
        guard let tableURL, let audioURL, let libraryURL, let manifestURL else { return }
        isWorking = true
        preview = nil
        errors = []
        resultText = ""
        Task.detached(priority: .userInitiated) {
            let scopedURLs = [tableURL, audioURL, libraryURL]
            let accessGranted = scopedURLs.map { $0.startAccessingSecurityScopedResource() }
            defer {
                for (url, granted) in zip(scopedURLs, accessGranted) where granted {
                    url.stopAccessingSecurityScopedResource()
                }
            }
            do {
                let value = try self.importer.preview(
                    tableURL: tableURL,
                    audioDirectory: audioURL,
                    manifestURL: manifestURL
                )
                await MainActor.run {
                    self.preview = value
                    self.isWorking = false
                }
            } catch {
                await MainActor.run {
                    self.errors = [error.localizedDescription]
                    self.isWorking = false
                }
            }
        }
    }

    func applyImport() {
        guard let preview, let libraryURL, let manifestURL else { return }
        isWorking = true
        errors = []
        Task.detached(priority: .userInitiated) {
            let granted = libraryURL.startAccessingSecurityScopedResource()
            defer { if granted { libraryURL.stopAccessingSecurityScopedResource() } }
            do {
                let result = try self.importer.apply(
                    preview,
                    libraryDirectory: libraryURL,
                    manifestURL: manifestURL
                )
                let assets = try self.importer.listAssets(manifestURL: manifestURL)
                await MainActor.run {
                    self.resultText = "导入完成：新增 \(result.added) · 更新 \(result.updated) · 未变更 \(result.unchanged)"
                    self.libraryAssets = assets
                    self.preview = nil
                    self.isWorking = false
                }
            } catch {
                await MainActor.run {
                    self.errors = [error.localizedDescription]
                    self.isWorking = false
                }
            }
        }
    }

    func setArchived(_ asset: LibraryAsset, archived: Bool) {
        guard let libraryURL, let manifestURL else { return }
        let granted = libraryURL.startAccessingSecurityScopedResource()
        defer { if granted { libraryURL.stopAccessingSecurityScopedResource() } }
        do {
            try importer.setArchived(asset.sourceID, archived: archived, manifestURL: manifestURL)
            libraryAssets = try importer.listAssets(manifestURL: manifestURL)
            if selectedAssetID == asset.sourceID { selectedAssetID = nil }
            resultText = archived ? "已归档：\(asset.metadata.name)（文件与历史版本均保留）" : "已恢复：\(asset.metadata.name)"
        } catch {
            errors = [error.localizedDescription]
        }
    }

    func selectAsset(_ asset: LibraryAsset) {
        selectedAssetID = asset.sourceID
    }

    func isPlaying(_ asset: LibraryAsset, version: LibraryAssetVersion) -> Bool {
        playingVersionKey == "\(asset.sourceID):\(version.version)" && (audioPlayer?.isPlaying ?? false)
    }

    func togglePlayback(_ asset: LibraryAsset, version: LibraryAssetVersion) {
        let key = "\(asset.sourceID):\(version.version)"
        if playingVersionKey == key, audioPlayer?.isPlaying == true {
            stopPlayback()
            return
        }
        stopPlayback()
        guard let libraryURL else {
            errors = ["请先选择素材库目录。"]
            return
        }
        let granted = libraryURL.startAccessingSecurityScopedResource()
        do {
            let player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: version.diskPath))
            guard player.prepareToPlay(), player.play() else {
                throw NSError(domain: "SyncCut.AudioPreview", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "音频无法开始播放。"
                ])
            }
            audioPlayer = player
            audioAccessGranted = granted
            playingVersionKey = key
            errors = []
        } catch {
            if granted { libraryURL.stopAccessingSecurityScopedResource() }
            errors = ["无法试听 \(version.filename)：\(error.localizedDescription)"]
        }
    }

    func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
        if audioAccessGranted, let libraryURL {
            libraryURL.stopAccessingSecurityScopedResource()
        }
        audioAccessGranted = false
        playingVersionKey = nil
    }

    func choose(_ target: PickerTarget) {
        picker = target
    }

    func accept(_ url: URL, for target: PickerTarget) {
        switch target {
        case .table:
            tableURL = url
            preview = nil
        case .audio:
            audioURL = url
            preview = nil
        case .library:
            stopPlayback()
            libraryURL = url
            preview = nil
            do {
                let bookmark = try url.bookmarkData(
                    options: [.withSecurityScope],
                    includingResourceValuesForKeys: nil,
                    relativeTo: nil
                )
                UserDefaults.standard.set(bookmark, forKey: libraryBookmarkKey)
            } catch {
                errors = ["无法保存素材库访问权限：\(error.localizedDescription)"]
            }
            refreshLibrary()
        }
    }

    private func restoreLibraryBookmark() {
        guard let bookmark = UserDefaults.standard.data(forKey: libraryBookmarkKey) else { return }
        var isStale = false
        do {
            let url = try URL(
                resolvingBookmarkData: bookmark,
                options: [.withSecurityScope],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            libraryURL = url
            if isStale {
                let refreshed = try url.bookmarkData(
                    options: [.withSecurityScope],
                    includingResourceValuesForKeys: nil,
                    relativeTo: nil
                )
                UserDefaults.standard.set(refreshed, forKey: libraryBookmarkKey)
            }
            refreshLibrary()
        } catch {
            UserDefaults.standard.removeObject(forKey: libraryBookmarkKey)
            errors = ["无法恢复上次素材库访问权限，请重新选择目录。"]
        }
    }

    private static func kindCode(_ label: String) -> String {
        switch label {
        case "音乐": return "music"
        case "音效": return "sfx"
        case "配音": return "voice"
        case "环境音": return "ambience"
        default: return label
        }
    }
}

struct AgentMenuView: View {
    @ObservedObject var model: AgentViewModel
    @State private var pendingArchive: LibraryAsset?
    @State private var showArchiveConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Picker("页面", selection: $model.activeTab) {
                Text("导入").tag("导入")
                Text("素材库").tag("素材库")
            }
            .pickerStyle(.segmented)

            if model.activeTab == "导入" {
                importPanel
            } else {
                libraryPanel
            }

            if !model.errors.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(model.errors, id: \.self) { error in
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if !model.resultText.isEmpty {
                Text(model.resultText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            HStack {
                Button("准备缓存") { model.prepareCache() }
                Button("打开缓存") { model.openCache() }
                Spacer()
                Button("退出") { NSApplication.shared.terminate(nil) }
                    .keyboardShortcut("q")
            }
            .font(.caption)
        }
        .padding(14)
        .frame(width: 420, height: 590)
        .confirmationDialog(
            "归档素材？",
            isPresented: $showArchiveConfirmation,
            titleVisibility: .visible
        ) {
            Button("归档素材") {
                if let asset = pendingArchive {
                    model.setArchived(asset, archived: true)
                }
                pendingArchive = nil
            }
            Button("取消", role: .cancel) { pendingArchive = nil }
        } message: {
            Text("将“\(pendingArchive?.metadata.name ?? "该素材")”从在用列表中隐藏。不会删除音频文件或历史版本，可在“已归档”中恢复。")
        }
        .fileImporter(
            isPresented: Binding(
                get: { model.picker != nil },
                set: { if !$0 { model.picker = nil } }
            ),
            allowedContentTypes: allowedTypes,
            allowsMultipleSelection: false
        ) { result in
            guard let target = model.picker else { return }
            model.picker = nil
            do {
                guard let url = try result.get().first else { return }
                model.accept(url, for: target)
            } catch {
                model.errors = [error.localizedDescription]
            }
        }
    }

    private var header: some View {
        HStack {
            Image(systemName: "waveform").foregroundStyle(.indigo)
            Text("SyncCut 助手").font(.headline)
            Spacer()
            Circle().fill(model.paired ? .green : .orange).frame(width: 7, height: 7)
            Text(model.status).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var importPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("本地素材导入").font(.subheadline.weight(.semibold))
                Spacer()
                if model.isWorking { ProgressView().controlSize(.small) }
            }
            pickerRow("素材清单", detail: model.tableURL?.lastPathComponent ?? "选择 CSV 文件", icon: "tablecells") {
                model.choose(.table)
            }
            pickerRow("音频目录", detail: model.audioURL?.lastPathComponent ?? "选择音频文件夹", icon: "folder") {
                model.choose(.audio)
            }
            pickerRow("素材库", detail: model.libraryURL?.path ?? "选择保存位置", icon: "externaldrive") {
                model.choose(.library)
            }
            Button { model.runPreview() } label: {
                Label("检查并预览", systemImage: "doc.magnifyingglass")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!model.canPreview)

            if let preview = model.preview {
                Divider()
                HStack(spacing: 12) {
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
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 110)
                } else {
                    Button { model.applyImport() } label: {
                        Label("确认导入", systemImage: "square.and.arrow.down")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    .disabled(!model.canImport)
                }
            }
        }
    }

    private var libraryPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("素材库").font(.subheadline.weight(.semibold))
                Spacer()
                Button("选择目录") { model.choose(.library) }
                Button { model.refreshLibrary() } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("刷新素材库")
                .disabled(model.libraryURL == nil)
            }
            if let libraryURL = model.libraryURL {
                HStack(spacing: 5) {
                    Image(systemName: "folder").foregroundStyle(.secondary)
                    Text(libraryURL.path)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                    Button { model.openLibrary() } label: {
                        Image(systemName: "arrow.up.right.square")
                    }
                    .buttonStyle(.plain)
                    .help("在 Finder 中打开")
                }
            } else {
                Text("先选择一个素材库目录，或在“导入”页面创建素材库。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            TextField("搜索名称、项目、集数、场景、标签…", text: $model.searchText)
                .textFieldStyle(.roundedBorder)
                .disabled(model.libraryURL == nil)

            HStack(spacing: 8) {
                Picker("状态", selection: $model.showArchived) {
                    Text("在用").tag(false)
                    Text("已归档").tag(true)
                }
                .pickerStyle(.segmented)
                Picker("类型", selection: $model.kindFilter) {
                    Text("全部").tag("全部")
                    Text("音乐").tag("音乐")
                    Text("音效").tag("音效")
                    Text("配音").tag("配音")
                    Text("环境音").tag("环境音")
                }
                .pickerStyle(.menu)
                .frame(width: 105)
            }

            HStack {
                Text("显示 \(model.visibleAssets.count) 项 · 素材库共 \(model.libraryAssets.count) 项")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                if model.isWorking { ProgressView().controlSize(.small) }
            }

            if model.libraryURL == nil {
                Spacer()
                Image(systemName: "externaldrive")
                    .font(.largeTitle)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
                Text("尚未选择素材库")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            } else if model.visibleAssets.isEmpty {
                Spacer()
                Image(systemName: model.showArchived ? "archivebox" : "waveform")
                    .font(.largeTitle)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
                Text(model.searchText.isEmpty ? "这里还没有素材" : "没有匹配的素材")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(model.visibleAssets) { asset in
                            assetRow(asset)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .frame(maxHeight: model.selectedAsset == nil ? 275 : 185)

                if let asset = model.selectedAsset {
                    Divider()
                    assetDetails(asset)
                }
            }
        }
    }

    private func assetRow(_ asset: LibraryAsset) -> some View {
        HStack(spacing: 7) {
            Button { model.selectAsset(asset) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(asset.metadata.name)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(assetLocation(asset))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("\(kindLabel(asset.metadata.kind)) · \(asset.versions.count) 个版本 · \(byteLabel(asset.versions.last?.sizeBytes ?? 0))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let latest = asset.versions.last {
                Button {
                    model.togglePlayback(asset, version: latest)
                } label: {
                    Image(systemName: model.isPlaying(asset, version: latest) ? "pause.fill" : "play.fill")
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("试听最新版本")
            }
            if asset.isArchived {
                Button("恢复") { model.setArchived(asset, archived: false) }
                    .controlSize(.small)
                    .help("恢复到在用列表")
            } else {
                Button {
                    pendingArchive = asset
                    showArchiveConfirmation = true
                } label: {
                    Image(systemName: "archivebox")
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("归档素材，不删除文件")
            }
        }
        .padding(8)
        .background(
            model.selectedAssetID == asset.sourceID
                ? Color.accentColor.opacity(0.13)
                : Color.secondary.opacity(0.06)
        )
        .clipShape(RoundedRectangle(cornerRadius: 9))
    }

    private func assetDetails(_ asset: LibraryAsset) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("版本历史").font(.caption.weight(.semibold))
                Spacer()
                Text(asset.metadata.project.isEmpty ? "未填写项目" : asset.metadata.project)
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if !asset.metadata.notes.isEmpty {
                Text(asset.metadata.notes)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if !asset.metadata.tags.isEmpty {
                Text("标签：" + asset.metadata.tags.joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(asset.versions.reversed()) { version in
                        HStack(spacing: 6) {
                            Text("v\(version.version)")
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .frame(width: 30, alignment: .leading)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(version.filename).font(.caption2).lineLimit(1)
                                Text("\(byteLabel(version.sizeBytes)) · \(String(version.sha256.prefix(12)))")
                                    .font(.system(size: 9, design: .monospaced))
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            Button {
                                model.togglePlayback(asset, version: version)
                            } label: {
                                Image(systemName: model.isPlaying(asset, version: version) ? "pause.fill" : "play.fill")
                            }
                            .buttonStyle(.plain)
                            .help("试听此版本")
                            Button {
                                model.revealVersion(version)
                            } label: {
                                Image(systemName: "folder")
                            }
                            .buttonStyle(.plain)
                            .help("在 Finder 中显示文件")
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 92)
        }
    }

    private var allowedTypes: [UTType] {
        switch model.picker {
        case .table: return [UTType(filenameExtension: "csv") ?? .commaSeparatedText]
        case .audio, .library: return [.folder]
        case .none: return [.item]
        }
    }

    private func pickerRow(
        _ title: String,
        detail: String,
        icon: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon).frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.caption.weight(.semibold))
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
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

    private func kindLabel(_ kind: String) -> String {
        switch kind {
        case "music": return "音乐"
        case "sfx": return "音效"
        case "voice": return "配音"
        case "ambience": return "环境音"
        default: return kind
        }
    }

    private func assetLocation(_ asset: LibraryAsset) -> String {
        [asset.metadata.project, asset.metadata.episode, asset.metadata.scene, asset.metadata.shot]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private func byteLabel(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
