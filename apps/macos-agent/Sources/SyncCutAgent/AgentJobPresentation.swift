func cloudJobCompletionMessage(assetCount: Int, reusedCount: Int) -> String {
    "任务完成：\(assetCount) 个素材已下载并通过 SHA-256 校验；\(reusedCount) 个文件复用了本地缓存。素材已放入 CloudAssets，剪映导入将在下一阶段接入。"
}
