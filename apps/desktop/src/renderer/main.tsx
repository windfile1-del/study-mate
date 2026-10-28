import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import{FloatingHost}from'./workspace/FloatingHost';
import './styles.css';
import type { StudyMateBridge } from '../shared/contracts';

declare global {
  interface Window {
    studyMate: StudyMateBridge;
  }
}

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h1>工作台未能加载</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {['assistant','navigation'].includes(new URLSearchParams(location.search).get('panel')||'')?<FloatingHost kind={new URLSearchParams(location.search).get('panel') as 'assistant'|'navigation'}/>:<App />}
  </ErrorBoundary>,
);
