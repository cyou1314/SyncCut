#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { previewImport, applyImportPlan, cleanupImportPreview } from '../src/local-importer.mjs';

const HELP = `SyncCut 本地素材导入

用法：
  npm run import:media -- --table <素材清单.csv|xlsx> --audio-dir <音频目录> --library <素材库目录>
  npm run import:media -- --table <素材清单.csv|xlsx> --audio-zip <音频包.zip> --library <素材库目录>

参数：
  --table       CSV 或 XLSX 素材清单
  --audio-dir   音频文件目录（递归扫描）
  --audio-zip   ZIP 音频附件包（二选一）
  --library     本地素材库目录，manifest.json 和版本文件写入此处
  --help        显示帮助

先预览并检查全部行；只有输入 IMPORT 才会复制素材。不会覆盖或删除源文件。
`;

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (!['--table', '--audio-dir', '--audio-zip', '--library'].includes(key)) {
      throw new Error('未知参数：' + key);
    }
    if (args[key] || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('参数缺少值或重复：' + key);
    }
    args[key] = argv[++i];
  }
  if (!args['--table'] || !args['--library']) {
    throw new Error('必须提供 --table 和 --library。');
  }
  if (Boolean(args['--audio-dir']) === Boolean(args['--audio-zip'])) {
    throw new Error('--audio-dir 和 --audio-zip 必须且只能提供一个。');
  }
  return {
    tablePath: path.resolve(args['--table']),
    audioDirectory: args['--audio-dir'] ? path.resolve(args['--audio-dir']) : undefined,
    audioZipPath: args['--audio-zip'] ? path.resolve(args['--audio-zip']) : undefined,
    libraryDirectory: path.resolve(args['--library']),
  };
}

function overlaps(a, b) {
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function runImportCli({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout } = {}) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { output.write(error.message + '\n\n' + HELP); return 2; }
  if (options.help) { output.write(HELP); return 0; }

  if (options.audioDirectory && (overlaps(options.audioDirectory, options.libraryDirectory) || overlaps(options.libraryDirectory, options.audioDirectory))) {
    output.write('音频源目录与素材库目录不能互相包含，避免扫描到已导入版本。\n');
    return 2;
  }

  const manifestPath = path.join(options.libraryDirectory, 'manifest.json');
  let plan;
  try {
    plan = await previewImport({
      tablePath: options.tablePath,
      audioDirectory: options.audioDirectory,
      audioZipPath: options.audioZipPath,
      manifestPath,
    });
    output.write('\n导入预览\n');
    output.write(`总行数：${plan.summary.total}｜可导入：${plan.summary.ready}｜错误：${plan.summary.errors}\n`);
    output.write(`新素材：${plan.summary.new}｜已有素材：${plan.summary.existing}\n`);
    if (plan.errors.length) {
      output.write('\n以下行需要修正：\n');
      for (const error of plan.errors) output.write(`第 ${error.row ?? '?'} 行：${error.reason}\n`);
      output.write('\n本次未导入任何素材。修正清单/附件后重新运行。\n');
      return 1;
    }
    output.write('\n确认后输入大写 IMPORT 执行导入；其他输入均取消。\n');
    const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
    let answer;
    try { answer = await rl.question('> '); } finally { rl.close(); }
    if (answer.trim() !== 'IMPORT') {
      output.write('已取消；未写入素材库。\n');
      return 0;
    }
    const result = await applyImportPlan({
      plan,
      libraryDirectory: options.libraryDirectory,
      manifestPath,
      confirm: true,
    });
    output.write('\n导入完成\n');
    output.write(`素材条目：${result.assetCount}\n`);
    output.write(`新增/更新/未变更：${result.changes.filter(x => x.action === 'added' || x.action === 'updated').length}/${result.changes.filter(x => x.metadataUpdated).length}/${result.changes.filter(x => x.action === 'unchanged').length}\n`);
    output.write(`清单：${result.manifestPath}\n`);
    return 0;
  } catch (error) {
    output.write('导入失败：' + error.message + '\n');
    return 1;
  } finally {
    if (plan) await cleanupImportPreview(plan).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runImportCli();
}
