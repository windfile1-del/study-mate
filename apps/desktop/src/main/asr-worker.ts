import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import sherpa from 'sherpa-onnx-node';
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: {
      model: path.join(workerData.models, 'model.int8.onnx'),
      language: workerData.language === 'chinese' ? 'zh' : 'en',
      useInverseTextNormalization: 1,
    },
    tokens: path.join(workerData.models, 'tokens.txt'),
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
  decodingMethod: 'greedy_search',
});
parentPort!.on('message', ({ id, samples }) => {
  try {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: new Float32Array(samples), sampleRate: 16000 });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    parentPort!.postMessage({
      id,
      value: {
        text: result.text || '',
        chunks: [{ text: result.text || '', timestamp: [0, samples.byteLength / 4 / 16000] }],
        tokens: result.tokens,
        timestamps: result.timestamps,
      },
    });
  } catch (e) {
    parentPort!.postMessage({ id, error: (e as Error).message });
  }
});
