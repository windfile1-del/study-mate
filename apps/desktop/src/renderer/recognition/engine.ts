import { env, pipeline } from '@huggingface/transformers';
import { createWorker } from 'tesseract.js';
const local = new URL('./recognition-runtime/', location.href).href;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'study-model://models/';
env.useBrowserCache = false;
env.backends.onnx.wasm!.wasmPaths = local + 'onnx/';
env.backends.onnx.wasm!.numThreads = 1;
env.backends.onnx.wasm!.proxy = false;
let embedding: any = null,
  ocr: any = null;
async function embed(texts: string[]) {
  if (!embedding)
    embedding = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
      dtype: 'q8',
      device: 'wasm',
    });
  const out = await embedding(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
}
async function recognize(image: string) {
  const probe = new Image();
  probe.src = image;
  await probe.decode();
  if (probe.naturalWidth * probe.naturalHeight > 12_000_000) {
    probe.src = '';
    throw Error('图片超过1200万像素，请裁剪后识别');
  }
  if (!ocr)
    ocr = await createWorker(['chi_sim', 'eng'], 1, {
      workerPath: local + 'tesseract/worker.min.js',
      corePath: local + 'tesseract/',
      langPath: local + 'languages/',
      cacheMethod: 'none',
      workerBlobURL: false,
    });
  const result = await ocr.recognize(image, {}, { blocks: true });
  const data = result.data,
    words: any[] = [];
  for (const block of data.blocks || [])
    for (const paragraph of block.paragraphs || [])
      for (const line of paragraph.lines || [])
        for (const word of line.words || [])
          words.push({
            text: word.text,
            confidence: word.confidence,
            x: word.bbox.x0,
            y: word.bbox.y0,
            width: word.bbox.x1 - word.bbox.x0,
            height: word.bbox.y1 - word.bbox.y0,
          });
  return { text: data.text, confidence: data.confidence, words };
}
let capture: {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  gain: GainNode;
} | null = null;
let packets: { wall: number; samples: number[] }[] = [];
async function startAudio() {
  if (capture) throw Error('正在采音');
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: { suppressLocalAudioPlayback: false } as MediaTrackConstraints,
    video: { frameRate: 1 },
  });
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    throw Error('当前标签未提供可采集音轨。');
  }
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule(new URL('./recognition-runtime/audio-worklet.js', location.href).href);
  await context.resume();
  const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())),
    node = new AudioWorkletNode(context, 'study-pcm'),
    gain = context.createGain();
  gain.gain.value = 0;
  source.connect(node).connect(gain).connect(context.destination);
  node.port.onmessage = ({ data }) => {
    packets.push({
      wall: Date.now() - (context.currentTime - data.start) * 1000,
      samples: Array.from(data.samples),
    });
    if (packets.length > 300) packets.splice(0, packets.length - 300);
  };
  capture = { stream, context, source, node, gain };
  packets = [];
  return { sampleRate: context.sampleRate };
}
async function stopAudio() {
  if (!capture) return;
  capture.node.port.postMessage('flush');
  await new Promise((r) => setTimeout(r, 50));
  capture.stream.getTracks().forEach((t) => t.stop());
  capture.node.disconnect();
  capture.source.disconnect();
  await capture.context.close();
  capture = null;
}
(window as any).studyRecognition = {
  async execute(action: string, input: any) {
    try {
      return {
        ok: true,
        value:
          action === 'embed'
            ? await embed(input.texts)
            : action === 'ocr'
              ? await recognize(input.image)
              : action === 'audio-start'
                ? await startAudio()
                : action === 'audio-stop'
                  ? await stopAudio()
                  : packets.splice(0),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};
