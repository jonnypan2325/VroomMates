import React from 'react';
import { QRCodeSVG } from 'qrcode.react';

// The most a QR code holds at level M, as bytes of text: long or non-Latin addresses reach it sooner.
const MAX_BYTES = 2331;
const tooLong = <p className="saving-note route-qr-too-long">This route is too long for a QR code. Use Open in Google Maps or Copy link.</p>;

// If a code still cannot be drawn, it says so here instead of taking the page down with it.
class QrBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? tooLong : this.props.children; }
}

// Drawn in the browser so the route link never goes to a QR web service.
export default function RouteQr({ value, title }) {
  if (new TextEncoder().encode(value).length > MAX_BYTES) return tooLong;
  return <QrBoundary key={value}>
    <QRCodeSVG value={value} title={title} size={184} level="M" marginSize={0} fgColor="#1f2430" />
  </QrBoundary>;
}
