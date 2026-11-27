import { createRoot } from "react-dom/client";
import AppErrorBoundary from "./components/AppErrorBoundary";
import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("EduTrack root element (#root) was not found in index.html.");
}

const root = createRoot(rootElement);

function renderStartupError(error: unknown) {
  console.error("[EduTrack] Application startup failed:", error);
  const message =
    error instanceof Error ? error.message : "An unknown startup error occurred.";

  root.render(
    <main className="grid min-h-screen place-items-center bg-slate-50 px-5 py-10 text-slate-900">
      <section className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <h1 className="text-xl font-black">EduTrack could not start</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          The application stopped while loading its configuration. This is usually caused by missing local environment variables.
        </p>
        <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-slate-100 p-4 text-xs leading-5 text-slate-800">{message}</pre>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Link this folder to the existing EduTrack Vercel project, add the Firebase configuration and Firebase Admin credentials to its Development environment, then run <code className="rounded bg-slate-100 px-1 py-0.5">npm run dev</code> again.
        </p>
      </section>
    </main>,
  );
}

// Load App dynamically so configuration/import errors are rendered as a useful
// startup screen instead of leaving the browser on a completely blank page.
void import("./App.tsx")
  .then(({ default: App }) => {
    root.render(
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>,
    );
  })
  .catch(renderStartupError);
