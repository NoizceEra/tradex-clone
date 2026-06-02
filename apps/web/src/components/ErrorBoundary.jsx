import { Component } from 'react';

/** Catches render/runtime errors in the tree so a single component throw can't white-screen
 *  the whole exchange. Shows a recoverable fallback. */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('UI error boundary caught:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-screen">
          <h2>Something went wrong</h2>
          <p>{String(this.state.error?.message ?? this.state.error)}</p>
          <button className="btn-primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
