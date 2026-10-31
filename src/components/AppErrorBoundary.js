import React from 'react';

/** The last line of defence: a render error anywhere shows a short message instead of a blank page. */
export default class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <p className="app-error" role="alert">Something went wrong. Reload the page.</p>;
  }
}
