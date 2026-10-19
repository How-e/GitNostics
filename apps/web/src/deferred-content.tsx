import { Component, Suspense, type ReactNode } from 'react';

/** Keep navigation available when an on-demand route or chart cannot download. */
class DownloadBoundary extends Component<
  { children: ReactNode; chart: boolean },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div role="alert" className={this.props.chart ? 'chart-loading' : 'page-loading'}>
          <span>This {this.props.chart ? 'chart' : 'page'} could not be loaded.</span>
          <button className="button" onClick={() => window.location.reload()}>
            Reload workspace
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function DeferredContent({
  children,
  label,
  chart = false,
}: {
  children: ReactNode;
  label: string;
  chart?: boolean;
}) {
  return (
    <DownloadBoundary chart={chart}>
      <Suspense
        fallback={
          <div role="status" className={chart ? 'chart-loading' : 'page-loading'}>
            {label}
          </div>
        }
      >
        {children}
      </Suspense>
    </DownloadBoundary>
  );
}
