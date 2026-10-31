import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null; resetKey: number };

/** Global recovery boundary for lazy chunks and page-level render failures. */
export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): State {
    return { error, resetKey: 0 };
  }

  private reset = () => {
    const chunkFailure = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(this.state.error?.message ?? "");
    if (chunkFailure) {
      const key = "arta.chunk-reload-attempted";
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        window.location.reload();
        return;
      }
    }
    this.setState((state) => ({ error: null, resetKey: state.resetKey + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="app-error-boundary">
          <strong>Konsol gagal dimuat</strong>
          <span>Data trading tidak diubah. Muat ulang halaman untuk mencoba lagi.</span>
          <button type="button" onClick={this.reset}>Muat ulang konsol</button>
        </div>
      );
    }
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}
