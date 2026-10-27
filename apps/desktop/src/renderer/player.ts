const query = new URLSearchParams(location.search);
document.title = query.get('title') || '本地视频';
const player = document.querySelector('video')!;
const asset = query.get('asset') || '';
if (/^study-media:\/\/asset\/[a-f0-9-]+$/.test(asset)) player.src = asset;
player.addEventListener('error', () => {
  document.getElementById('status')!.textContent =
    '无法解码此视频。当前内置 Chromium 不支持该文件的编码或文件已损坏，可换用 MP4（H.264）或 WebM。';
});
export {};
