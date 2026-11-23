import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteControl, RemoteHostState } from '../../shared/remote';
import './remote.css';
import { NoteSyncPanel } from './NoteSyncPanel';
export function RemotePanel({ onClose, onPlaybackRequested, onPlaybackResumed, onPlaybackFailed, initialError = '' }: { onClose: () => void; onPlaybackRequested: () => void; onPlaybackResumed: () => void; onPlaybackFailed: (message: string) => void; initialError?: string }) {
  const [state, setState] = useState<RemoteHostState | null>(null),
    [address, setAddress] = useState(''),
    [error, setError] = useState(initialError),
    [pending, setPending] = useState(false);
  const run = async (input: RemoteControl) => {
    setPending(true);
    if (input.action !== 'state') setError('');
    try {
      if (input.action === 'accept-playback') {
        onPlaybackRequested();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }
      const next = await window.studyMate.remote(input);
      if (input.action === 'accept-playback') { onPlaybackResumed(); return; }
      setState(next);
      setAddress((old) => old || next.address || next.interfaces[0]?.address || '');
    } catch (e) {
      if (input.action === 'accept-playback') onPlaybackFailed((e as Error).message);
      else setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    void run({ action: 'state' });
    const timer = setInterval(
      () =>
        void window.studyMate
          .remote({ action: 'state' })
          .then((next) => {
            setState(next);
            setAddress((old) => old || next.address || next.interfaces[0]?.address || '');
          })
          .catch(() => {}),
      1500,
    );
    return () => clearInterval(timer);
  }, []);
  return createPortal(
    <div className="remote-backdrop" onClick={onClose}>
      <section
        className="remote-panel"
        role="dialog"
        aria-modal="true"
        aria-label="平板连接"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <h2>平板连接</h2>
            <p>在同一局域网中接续学习。平板只读，模型和资料由这台电脑提供。</p>
          </div>
          <button onClick={onClose} aria-label="关闭平板连接">
            关闭
          </button>
        </header>
        {error && (
          <p role="alert" className="remote-error">
            {error}
          </p>
        )}
        {state?.error && <p className="remote-error">{state.error}</p>}
        <div className="remote-actions">
          <label>
            局域网网卡
            <select
              aria-label="局域网网卡"
              value={address}
              disabled={state?.enabled || pending}
              onChange={(e) => setAddress(e.target.value)}
            >
              {state?.interfaces.map((i) => (
                <option key={i.address} value={i.address}>
                  {i.name} · {i.address}{/vmware|virtual|vmnet|vpn|tun|tap|蓝牙/i.test(i.name) ? '（虚拟网卡，普通 Wi-Fi 平板勿选）' : /wlan|wi-fi|wifi/i.test(i.name) ? '（Wi-Fi 推荐）' : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            disabled={pending || (!state?.enabled && !address)}
            onClick={() => void run(state?.enabled ? { action: 'disable' } : { action: 'enable', address })}
          >
            {state?.enabled ? '关闭连接服务' : '开启连接服务'}
          </button>
          {state?.enabled && (
            <button disabled={pending} onClick={() => void run({ action: 'pair-code' })}>
              生成配对二维码
            </button>
          )}
        </div>
        {state?.enabled && (
          <p>
            服务已开启 · {state.address}:{state.port}。若平板无法访问，请检查 Windows
            专用网络防火墙和路由器客户端隔离。
          </p>
        )}
        {state?.qr && (
          <div className="remote-pair">
            <img src={state.qr} alt="Study Mate 一次性配对二维码" />
            <div>
              <h3>使用平板扫描</h3>
              <p>二维码三分钟内有效。扫描后在本页确认设备。</p>
              <p>首次手动配对请核对电脑证书指纹。</p>
              <code>{state.pin}</code>
              <details>
                <summary>手动连接信息</summary>
                <textarea
                  aria-label="完整配对连接信息"
                  readOnly
                  rows={5}
                  value={JSON.stringify(state.pairCode)}
                  style={{ width: '100%', fontSize: 11 }}
                />
              </details>
            </div>
          </div>
        )}
        {!!state?.playbackOffers.length && <>
          <h3>从平板接续课程</h3>
          {state.playbackOffers.map((offer) => <div className="remote-device" data-playback-offer={offer.id} key={offer.id}>
            <strong>{offer.title}</strong>
            <span>{offer.deviceName} · {Math.floor(offer.position / 60)}:{String(Math.floor(offer.position % 60)).padStart(2, '0')} · {offer.rate}×</span>
            <button className="primary" disabled={pending} onClick={() => void run({ action: 'accept-playback', id: offer.id })}>在电脑继续播放</button>
            <button disabled={pending} onClick={() => void run({ action: 'dismiss-playback', id: offer.id })}>忽略</button>
          </div>)}
          <p>确认后切换电脑课程并从该位置播放；平板播放进度不会自动覆盖电脑。</p>
        </>}
        <NoteSyncPanel />
        <h3>等待确认</h3>
        {!state?.pending.length && <p>暂无配对申请</p>}
        {state?.pending.map((p) => (
          <div className="remote-device" key={p.id}>
            <strong>{p.name}</strong>
            <span>申请读取当前知识库与学习对话</span>
            <button disabled={pending} onClick={() => void run({ action: 'approve', id: p.id })}>
              允许配对
            </button>
            <button disabled={pending} onClick={() => void run({ action: 'reject', id: p.id })}>
              拒绝
            </button>
          </div>
        ))}
        <h3>已配对设备</h3>
        {!state?.devices.some((d) => !d.revoked) && <p>尚未配对设备</p>}
        {state?.devices
          .filter((d) => !d.revoked)
          .map((d) => (
            <div className="remote-device" key={d.id}>
              <strong>{d.name}</strong>
              <span>最近连接 {new Date(d.lastSeenAt).toLocaleString()}</span>
              <button disabled={pending} onClick={() => void run({ action: 'grant', id: d.id })}>
                授权当前知识库
              </button>
              <button disabled={pending} onClick={() => void run({ action: 'revoke', id: d.id })}>
                解除配对
              </button>
            </div>
          ))}
        <footer>电脑需要保持运行。首版平板不提供笔记编辑、模型配置和任务创建。</footer>
      </section>
    </div>, document.body
  );
}
