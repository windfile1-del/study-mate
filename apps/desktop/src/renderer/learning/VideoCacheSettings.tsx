import { useEffect, useState } from 'react';
import { Clock3, Database, Trash2, LoaderCircle } from 'lucide-react';
import type { VideoCacheState, VideoCacheSettings as Settings } from '../../shared/video-cache';
import './video-cache.css';
export function VideoCacheSettings() {
  const [state, setState] = useState<VideoCacheState | null>(null),
    [form, setForm] = useState<Settings | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    const poll = () =>
      window.studyMate
        .videoCache({ action: 'state' })
        .then((s) => {
          if (live) {
            setState(s);
            setForm((current) => current ?? s.settings);
          }
        })
        .catch((e) => {
          if (live) setMessage(e.message);
        });
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  async function run(action: 'configure' | 'clean') {
    if (!form) return;
    setBusy(true);
    setMessage('');
    try {
      const next = await window.studyMate.videoCache(
        action === 'configure' ? { action, settings: form } : { action },
      );
      setState(next);
      setForm(next.settings);
      setMessage(
        action === 'configure'
          ? '已保存，按新设置定时清理。'
          : `清理完成：释放 ${(next.bytesFreed / 1048576).toFixed(1)} MB，移除 ${next.removed} 帧。`,
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!form) return <p>{message || '正在读取缓存设置…'}</p>;
  return (
    <section className="video-cache-settings" aria-label="视频帧缓存设置">
      <div className="video-cache-heading">
        <span>
          <Database size={22} />
        </span>
        <div>
          <h3>让画面跟上你的提问</h3>
          <p>播放时自动缓存约每 2 秒一帧，最高 640 × 360。模型可按需查看原视频片段，缓存只是快速入口。</p>
        </div>
      </div>
      <label className="video-cache-toggle">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        自动缓存低分辨率画面
      </label>
      <div className="video-cache-fields">
        <label>
          保留时长
          <select
            aria-label="视频缓存保留时长"
            value={form.retentionHours}
            onChange={(e) => setForm({ ...form, retentionHours: +e.target.value })}
          >
            <option value={24}>1 天</option>
            <option value={72}>3 天</option>
            <option value={168}>7 天</option>
            <option value={720}>30 天</option>
            {![24, 72, 168, 720].includes(form.retentionHours) && (
              <option value={form.retentionHours}>{form.retentionHours} 小时</option>
            )}
          </select>
        </label>
        <label>
          总空间上限
          <select
            aria-label="视频缓存空间上限"
            value={form.maxMegabytes}
            onChange={(e) => setForm({ ...form, maxMegabytes: +e.target.value })}
          >
            {[32, 128, 256, 512, 1024, 2048].map((n) => (
              <option value={n} key={n}>
                {n} MB
              </option>
            ))}
          </select>
        </label>
        <label>
          清理频率
          <select
            aria-label="视频缓存清理频率"
            value={form.cleanupMinutes}
            onChange={(e) => setForm({ ...form, cleanupMinutes: +e.target.value })}
          >
            {[1, 5, 10, 30, 60].map((n) => (
              <option value={n} key={n}>
                每 {n} 分钟
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="video-cache-info">
        <Clock3 size={16} />
        <p>
          过期优先清理；超出空间时从最旧画面开始淘汰。单课另有 2400 帧 / 96 MB
          上限。仅清理自动画面，不删除原视频、字幕、转写、笔记或手动解析结果。
          <br />
          最近清理：{state?.lastCleanup ? new Date(state.lastCleanup).toLocaleString('zh-CN') : '尚未执行'} ·
          扫描时剩余 {((state?.cachedBytes || 0) / 1048576).toFixed(1)} MB / {state?.cachedFrames || 0} 帧
        </p>
      </div>
      <div className="video-cache-actions">
        <button className="learning-primary" disabled={busy} onClick={() => void run('configure')}>
          {busy ? <LoaderCircle size={15} className="spin" /> : null}保存缓存设置
        </button>
        <button disabled={busy} onClick={() => void run('clean')}>
          <Trash2 size={15} />
          立即清理过期缓存
        </button>
      </div>
      {(message || state?.error) && (
        <p className="video-cache-message" role="status">
          {message || state?.error}
        </p>
      )}
      <p className="video-cache-hint">
        缓存与定时清理在本机完成，不消耗模型额度。勾选对话框“自动看课”后，提问才会触发模型按需读取字幕、画面或原视频片段。
      </p>
    </section>
  );
}
