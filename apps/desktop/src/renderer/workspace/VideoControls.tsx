import { useEffect, useRef, useState } from 'react';
import { Maximize2, Pause, Play, Subtitles } from 'lucide-react';
import type { PlayerRequest, PlayerState } from '../../shared/player';
import './video-controls.css';
const stamp = (time: number) => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
export function VideoControls({ active }: { active: boolean }) {
  const [state, setState] = useState<PlayerState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [seeking, setSeeking] = useState<number | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    if (!active) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = epoch.current;
      try {
        const next = await window.studyMate.player({ action: 'state' });
        if (alive && version === epoch.current) setState(next);
      } catch {
      } finally {
        if (alive) timer = setTimeout(poll, 800);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [active]);
  const run = async (command: PlayerRequest) => {
    epoch.current++;
    setBusy(true);
    setError('');
    try {
      setState(await window.studyMate.player(command));
    } catch (e) {
      setError(e instanceof Error ? e.message : '播放操作失败');
    } finally {
      setBusy(false);
    }
  };
  if (!active) return null;
  return (
    <div className={'video-controls ' + (state?.focused ? 'is-focused' : '')}>
      <div className="video-controls-heading">
        <span>
          <Maximize2 size={13} />
          {state?.focused ? '专注观看' : '课程播放器'}
        </span>
        <button
          aria-label="纯视频模式"
          aria-pressed={!!state?.focused}
          disabled={busy || !state?.available}
          onClick={() => void run({ action: 'mode', enabled: !state?.focused })}
        >
          {state?.focused ? '恢复原网页' : '开启纯视频'}
        </button>
      </div>
      {state?.focused ? (
        <div className="video-controls-row">
          <button
            aria-label={state.paused ? '播放视频' : '暂停视频'}
            disabled={busy}
            onClick={() => void run({ action: state.paused ? 'play' : 'pause' })}
          >
            {state.paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <span className="video-time">{stamp(seeking ?? state.time)}</span>
          <input
            type="range"
            aria-label="视频进度"
            min={0}
            max={Math.max(1, state.duration)}
            step={0.1}
            disabled={busy || !state.duration}
            value={Math.min(seeking ?? state.time, state.duration || 0)}
            onChange={(e) => setSeeking(Number(e.target.value))}
            onPointerUp={(e) => {
              const value = Number(e.currentTarget.value);
              setSeeking(null);
              void run({ action: 'seek', time: value });
            }}
            onKeyUp={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                setSeeking(null);
                void run({ action: 'seek', time: Number(e.currentTarget.value) });
              }
            }}
          />
          <span className="video-time">{stamp(state.duration)}</span>
          <select
            aria-label="播放倍速"
            value={state.rate}
            disabled={busy}
            onChange={(e) => void run({ action: 'rate', rate: Number(e.target.value) })}
          >
            {[...new Set([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, state.rate])]
              .sort((a, b) => a - b)
              .map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
          </select>
          <button
            aria-label="切换视频字幕"
            aria-pressed={state.subtitles}
            title={state.captionsAvailable ? '开关已有字幕' : '当前视频未提供字幕；可先在原网页启用字幕'}
            disabled={busy || !state.captionsAvailable}
            onClick={() => void run({ action: 'subtitles', enabled: !state.subtitles })}
          >
            <Subtitles size={15} />
          </button>
        </div>
      ) : (
        <small>
          {state?.available
            ? '只显示视频与可选字幕，隐藏网页评论和弹幕；保留原播放会话。'
            : '等待网页中的可访问视频；跨域内嵌播放器可能不支持。'}
        </small>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
