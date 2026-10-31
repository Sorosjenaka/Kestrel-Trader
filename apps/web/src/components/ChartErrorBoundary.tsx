import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null; resetKey: number };

/**
 * Chart-local recovery boundary. A single Lightweight Charts failure must not
 * remove the rest of the operator console or the other panels.
 */
export class ChartErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): State {
    return { error, resetKey: 0 };
  }

  private reset = () => {
    this.setState((state) => ({ error: null, resetKey: state.resetKey + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="chart-error-boundary">
          <strong>Chart gagal dimuat</strong>
          <span>Panel lain tetap berjalan. Coba muat ulang panel ini.</span>
          <button type="button" onClick={this.reset}>Muat ulang chart</button>
        </div>
      );
    }
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}
