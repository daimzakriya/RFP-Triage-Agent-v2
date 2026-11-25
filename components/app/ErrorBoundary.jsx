import { Component } from "react";

/* Keeps one broken report from taking down the whole workspace. */
export default class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error("[rfp-ui]", error); }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback === null) return null;
    return this.props.fallback ? this.props.fallback(this.state.error) : (
      <div className="h-full grid place-items-center p-8 text-center">
        <div className="max-w-md">
          <h2 className="text-[17px] font-semibold">This screen couldn&apos;t be shown</h2>
          <p className="mt-2 text-ink-2 text-[13.5px]">Something in the saved data didn&apos;t look as expected. Your other reports are fine.</p>
        </div>
      </div>
    );
  }
}
