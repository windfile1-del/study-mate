# 本地识别与检索组件

Study Mate 0.9.0 随包提供以下运行库及模型，不在产品运行时下载模型或调用额外命令行程序。原作者、模型名及许可保留如下；许可原文在本目录 licenses 中。

| 组件 | 来源 | 许可 |
| --- | --- | --- |
| sherpa-onnx / sherpa-onnx-node 2.0.0 | https://github.com/k2-fsa/sherpa-onnx | Apache-2.0 |
| SenseVoiceSmall int8 ONNX | https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 ，revision 2365baeacb507f821a0c8120fcee3d484dba7a07 | 权重遵循 FunASR Model Open Source License Agreement；SenseVoice 源码 MIT，不将源码许可替代模型许可 |
| SenseVoice / FunAudioLLM | https://github.com/FunAudioLLM/SenseVoice ，https://huggingface.co/FunAudioLLM/SenseVoiceSmall | 见上述模型许可与 MIT 源码许可 |
| paraphrase-multilingual-MiniLM-L12-v2, quantized ONNX | https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2 ，revision 2c4055b12046f11709e9df2c122e59ffbdc2f900；原模型 https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 | Apache-2.0 |
| Transformers.js 4.3.1 | https://github.com/huggingface/transformers.js | Apache-2.0 |
| ONNX Runtime | https://github.com/microsoft/onnxruntime | MIT |
| Tesseract.js 7.0.0 / tesseract.js-core | https://github.com/naptha/tesseract.js ，https://github.com/naptha/tesseract.js-core | Apache-2.0 |
| Tesseract eng / chi_sim 数据 | https://github.com/tesseract-ocr/tessdata | Apache-2.0 |

ASR 与向量模型为本地 CPU 推理；Tesseract 是可选参考文字提取器，复杂公式、手写和模糊图像优先通过视觉模型核对原图。没有附带 Whisper 或 SoundTouch 实验资产。模型权重和 tokenizer 的固定版本清单在 resources/local-models/manifest.json；准备脚本 scripts/prepare-learning-models.mjs 校验远程固定 revision 的文件大小与 LFS SHA256。
