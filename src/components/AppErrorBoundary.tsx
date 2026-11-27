import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { hasError: boolean };

/** Prevents an uncaught React render error from leaving the app as a blank page. */
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[EduTrack] Unhandled application render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="grid min-h-screen place-items-center bg-slate-50 px-5 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
          <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-xl dark:border-white/10 dark:bg-slate-900">
            <h1 className="text-xl font-black">EduTrack could not load this page</h1>
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">An unexpected page error occurred. Your account data has not been changed. Reload the page to try again.</p>
            <button type="button" onClick={() => window.location.reload()} className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-blue-700">Reload application</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
