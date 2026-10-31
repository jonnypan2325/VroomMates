import React from 'react';
import { render, screen } from '@testing-library/react';
import { TextEncoder } from 'util';
import RouteQr from './RouteQr';

const mockQr = { fail: false };
jest.mock('qrcode.react', () => {
  const actual = jest.requireActual('qrcode.react');
  return { ...actual, QRCodeSVG: (props) => {
    if (mockQr.fail) throw new Error('Data too long');
    return <actual.QRCodeSVG {...props} />;
  } };
});
beforeAll(() => { global.TextEncoder = TextEncoder; });
beforeEach(() => { mockQr.fail = false; });
const TOO_LONG = 'This route is too long for a QR code. Use Open in Google Maps or Copy link.';

it('draws a QR code for a route link', () => {
  render(<RouteQr value="https://www.google.com/maps/dir/?api=1&origin=Home" title="QR code for this route" />);
  expect(screen.getByTitle('QR code for this route')).toBeInTheDocument();
});

it('says a link is too long rather than failing, counting the bytes of non-Latin addresses', () => {
  // 800 characters, but 2400 bytes once encoded, past what a QR code holds.
  render(<RouteQr value={'https://www.google.com/maps/dir/?api=1&waypoints=' + '東'.repeat(800)} title="QR code for this route" />);
  expect(screen.getByText(TOO_LONG)).toBeInTheDocument();
  expect(screen.queryByTitle('QR code for this route')).not.toBeInTheDocument();
});

it('says the same if the QR code still cannot be drawn, and the page carries on', () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockQr.fail = true;
  render(<><RouteQr value="https://www.google.com/maps/dir/?api=1&origin=Home" title="QR code for this route" /><p>Rest of the page</p></>);
  expect(screen.getByText(TOO_LONG)).toBeInTheDocument();
  expect(screen.getByText('Rest of the page')).toBeInTheDocument();
  console.error.mockRestore();
});
