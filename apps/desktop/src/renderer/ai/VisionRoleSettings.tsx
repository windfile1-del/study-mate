import { useState } from 'react';
import { ScanEye, Check, ExternalLink } from 'lucide-react';
import { AI_PRESETS, type AiState, type AiRequest, type AiConfig } from '../../shared/ai';
import './vision-role.css';
export function VisionRoleSettings({
  state,
  run,
}: {
  state: AiState;
  run: (request: AiRequest) => Promise<AiState | null | undefined>;
}) {
  const [enabled, setEnabled] = useState(state.vision?.enabled || false),
    [config, setConfig] = useState<AiConfig>(
      state.vision?.config || { ...state.config, maxOutput: Math.min(2048, state.config.maxOutput) },
    ),
    [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const preset = AI_PRESETS.find((p) => p.id === config.preset) || AI_PRESETS.at(-1)!;
  const change = (patch: Partial<AiConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setNotice('');
  };
  const save = async () => {
    setBusy(true);
    try {
      const next = await run({ action: 'configureVision', enabled, config, key: key || undefined });
      if (next) {
        setKey('');
        setNotice('视觉分工已保存，下一次提问生效。');
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="vision-role-card" aria-label="视觉与推理模型分工">
      <div className="vision-role-heading">
        <span>
          <ScanEye size={21} />
        </span>
        <div>
          <h3>图像识别专员</h3>
          <p>让视觉模型看清原图，让主模型专注推理与写作。</p>
        </div>
      </div>
      <label className="vision-role-toggle">
        <input
          type="checkbox"
          aria-label="启用独立视觉模型"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setNotice('');
          }}
        />
        启用视觉与文本双模型
      </label>
      <p className="vision-role-help">
        主模型使用上方服务与推理设置；下方视觉专员只读取图片、公式、图表和视频画面，输出观察及不确定性，不能修改笔记。文本主模型会收到识别结果和来源链接，无需支持图片。
      </p>
      {enabled && (
        <>
          <div className="vision-role-grid">
            <label>
              视觉服务
              <select
                aria-label="视觉服务"
                value={config.preset}
                onChange={(e) => {
                  const p = AI_PRESETS.find((p) => p.id === e.target.value)!;
                  setConfig(
                    state.profiles[p.id] || {
                      ...config,
                      preset: p.id,
                      protocol: p.protocol,
                      baseUrl: p.url,
                      model: p.model,
                    },
                  );
                  setKey('');
                  setNotice('');
                }}
              >
                {AI_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              视觉模型 ID
              <input
                aria-label="视觉模型 ID"
                value={config.model}
                placeholder="填写服务商提供的视觉模型 ID"
                onChange={(e) => change({ model: e.target.value })}
              />
            </label>
          </div>
          <label>
            视觉接口地址
            <input
              aria-label="视觉接口地址"
              value={config.baseUrl}
              disabled={['siwc', 'antigravity'].includes(config.protocol)}
              onChange={(e) => change({ baseUrl: e.target.value })}
            />
          </label>
          {!['siwc', 'antigravity'].includes(config.protocol) ? (
            <label>
              视觉 API Key{' '}
              <small>
                {state.vision?.hasKey
                  ? '已有可用密钥，留空保留'
                  : '可留空复用已配置服务的密钥；也可填写独立密钥'}
              </small>
              <input
                aria-label="视觉 API Key"
                type="password"
                autoComplete="off"
                value={key}
                placeholder="留空可复用同一服务已保存的密钥"
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
          ) : (
            <p className="vision-role-help">
              订阅服务复用本应用已授权的同类账号；请先在主服务接入区完成该服务登录，再配置视觉模型。
            </p>
          )}
          <button
            className="vision-role-portal"
            onClick={() => void run({ action: 'link', url: preset.portal })}
          >
            查看服务商接入入口
            <ExternalLink size={13} />
          </button>
        </>
      )}
      <div className="vision-role-actions">
        <button disabled={busy || state.busy} onClick={() => void save()}>
          <Check size={14} />
          {busy ? '保存中…' : '保存图像识别设置'}
        </button>
        {notice && <small role="status">{notice}</small>}
      </div>
      <p className="vision-role-help">
        不额外下载本地模型。图像只在提问的工具读取时交给视觉服务，两种模型的调用和用量分别显示。
      </p>
    </section>
  );
}
