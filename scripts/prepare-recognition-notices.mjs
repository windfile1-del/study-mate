import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('vendor/recognition/licenses');
if (!/^d:/i.test(root)) throw Error('暂存只允许D盘');
await fs.mkdir(root, { recursive: true });
const sources = {
  'SenseVoice-MODEL_LICENSE.txt': 'https://raw.githubusercontent.com/modelscope/FunASR/main/MODEL_LICENSE',
  'SenseVoice-code-MIT.txt': 'https://raw.githubusercontent.com/FunAudioLLM/SenseVoice/main/LICENSE',
  'sherpa-onnx-Apache-2.0.txt': 'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/LICENSE',
  'ONNXRuntime-MIT.txt': 'https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE',
  'Tesseract-data-Apache-2.0.txt': 'https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/LICENSE',
  'MiniLM-Apache-2.0.txt': 'https://raw.githubusercontent.com/UKPLab/sentence-transformers/master/LICENSE',
};
const results = await Promise.allSettled(
  Object.entries(sources).map(async ([name, url]) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw Error(url + ' ' + res.status);
    await fs.writeFile(path.join(root, name), await res.text());
    console.log(name);
  }),
);
for (const result of results) if (result.status === 'rejected') throw result.reason;
for (const [name, file] of Object.entries({
  'Transformers-Apache-2.0.txt': 'node_modules/@huggingface/transformers/LICENSE',
  'Tesseract-js-Apache-2.0.txt': 'node_modules/tesseract.js/LICENSE.md',
  'Tesseract-core-Apache-2.0.txt': 'node_modules/tesseract.js-core/LICENSE',
}))
  await fs.copyFile(file, path.join(root, name));
await fs.writeFile(
  path.join(root, 'sources.json'),
  JSON.stringify({ retrievedAt: new Date().toISOString(), sources }, null, 2),
);
