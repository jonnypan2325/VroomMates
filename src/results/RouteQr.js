import React from 'react';
import { QRCodeSVG } from 'qrcode.react';

// Drawn in the browser so the route link never goes to a QR web service.
export default function RouteQr({ value, title }) {
  return <QRCodeSVG value={value} title={title} size={184} level="M" marginSize={0} fgColor="#1f2430" />;
}
