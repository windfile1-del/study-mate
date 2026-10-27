import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve('vendor/local-models');
if (!/^d:/i.test(root)) throw Error('模型只允许暂存在D盘。');
const definitions = [
  {
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    directory: 'sensevoice',
    revision: '2365baeacb507f821a0c8120fcee3d484dba7a07',
    files: ['model.int8.onnx', 'tokens.txt', 'LICENSE'],
  },
  {
    repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'onnx/model_quantized.onnx',
    ],
  },
];
for (const definition of definitions) {
  const response = await fetch(
    `https://huggingface.co/api/models/${definition.repo}/revision/${definition.revision}?blobs=true`,
  );
  if (!response.ok) throw Error('模型清单不可用');
  const metadata = await response.json();
  for (const name of [...definition.files, 'README.md']) {
    const expected = metadata.siblings.find((f) => f.rfilename === name);
    if (!expected) throw Error('缺少固定模型资源 ' + name);
    const file = path.join(root, definition.directory || definition.repo, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (
      await fs.stat(file).then(
        (s) => s.size === expected.size,
        () => false,
      )
    ) {
      const bytes = await fs.readFile(file);
      if (!expected.lfs?.sha256 || createHash('sha256').update(bytes).digest('hex') === expected.lfs.sha256)
        continue;
    }
    const remote = await fetch(
      `https://huggingface.co/${definition.repo}/resolve/${definition.revision}/${name}`,
      { signal: AbortSignal.timeout(300000) },
    );
    if (!remote.ok) throw Error('模型下载失败 ' + name);
    const temporary = file + '.part';
    const handle = await fs.open(temporary, 'w');
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of remote.body) {
        size += chunk.length;
        if (size > expected.size) throw Error('模型资源超出声明大小');
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    if (size !== expected.size || (expected.lfs?.sha256 && hash.digest('hex') !== expected.lfs.sha256))
      throw Error('模型大小或哈希不匹配 ' + name);
    await fs.rename(temporary, file);
    console.log(definition.repo, name, size);
  }
}
await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(definitions, null, 2));
