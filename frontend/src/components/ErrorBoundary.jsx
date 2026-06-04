import { Component } from 'react';

// Keeps a single view's runtime error from white-screening the whole app.
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }); }
  render() {
    if (this.state.err) {
      return (
        <div className="empty">
          <div className="emoji">⚠️</div>
          <div className="t">Something went wrong in this view</div>
          <div className="s">{String(this.state.err.message || this.state.err)}</div>
          <div style={{ marginTop: 12 }}><button className="btn sm" onClick={() => this.setState({ err: null })}>Retry</button></div>
        </div>
      );
    }
    return this.props.children;
  }
}
