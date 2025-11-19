import React from 'react';
import ReactDOM from 'react-dom/client';
import { Buffer } from 'buffer';
import App, { SotaErrorBoundary } from './App';

// SOTA FIX: Polyfill the global Buffer object. Some dependencies like '@anthropic-ai/sdk'
// implicitly rely on this being available in a browser environment, and its absence
// causes a top-level ReferenceError that results in a blank screen. This must
// be done at the application's entry point before any other modules are loaded.
// @ts-ignore - This is a polyfill for browser environments.
(window as any).Buffer = Buffer;

// Application's entry point.
const rootElement = document.getElementById('root');
if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <React.StrictMode>
            <SotaErrorBoundary>
                <App />
            </SotaErrorBoundary>
        </React.StrictMode>
    );
}