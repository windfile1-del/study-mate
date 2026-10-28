import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type Result, type StudyMateBridge } from '../shared/contracts';

async function call<T>(channel: string, input?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, input)) as Result<T>;
  if (!result.ok) {
    const error = new Error(result.error.message) as Error & { code: string };
    error.code = result.error.code;
    throw error;
  }
  return result.value;
}
const bridge: StudyMateBridge = {
  library:input=>call(CHANNELS.library,input),
  panel:input=>call(CHANNELS.panel,input),
  onPanelEvent:listener=>{const handler=(_event:unknown,value:import('../shared/panels').PanelEvent)=>listener(value);ipcRenderer.on(CHANNELS.panelEvent,handler);return()=>ipcRenderer.removeListener(CHANNELS.panelEvent,handler);},
  annotation:input=>call(CHANNELS.annotation,input),
  videoCache:input=>call(CHANNELS.videoCache,input),
  ai: (input) => call('ai:request', input),
  state: () => call(CHANNELS.state),
  chooseDocument: () => call(CHANNELS.chooseDocument),
  recognition:input=>call(CHANNELS.recognition,input),
  knowledge:input=>call(CHANNELS.knowledge,input),
  document: (input) => call(CHANNELS.document, input),
  chooseVault: () => call(CHANNELS.chooseVault),
  importNotes: () => call(CHANNELS.importNotes),
  importImages: () => call(CHANNELS.importImages),
  openFolder: (input) => call(CHANNELS.openFolder, input),
  openLocal: () => call(CHANNELS.openLocal),
  openSource: (input) => call(CHANNELS.openSource, input),
  analyze: (input) => call(CHANNELS.analyze, input),
  listNotes: () => call(CHANNELS.listNotes),
  readNote: (input) => call(CHANNELS.readNote, input),
  resolveNoteLink: (vaultId, base, target, wiki) =>
    call(CHANNELS.resolveLink, { vaultId, base, target, wiki }),
  noteImage: (vaultId, base, target, wiki) => call(CHANNELS.noteImage, { vaultId, base, target, wiki }),
  saveNote: (input) => call(CHANNELS.saveNote, input),
  searchNotes: (input) => call(CHANNELS.searchNotes, input),
  openWeb: (input) => call(CHANNELS.openWeb, input),
  setBrowserBounds: (input) => call(CHANNELS.bounds, input),
  player: (input) => call(CHANNELS.player, input),
  closeWeb: () => call(CHANNELS.closeWeb),
  captureContext: () => call(CHANNELS.capture),
  cancelTask: (input) => call(CHANNELS.cancel, input),
  setDirty: (input) => call(CHANNELS.dirty, input),
  onChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(CHANNELS.changed, handler);
    return () => ipcRenderer.removeListener(CHANNELS.changed, handler);
  },
};
contextBridge.exposeInMainWorld('studyMate', bridge);
