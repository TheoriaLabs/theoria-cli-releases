import QRCode from 'qrcode';

/** A QR code for a link, drawn with Unicode half blocks, two rows per line. Scanners read it in either colour. */
export function qr(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'utf8', errorCorrectionLevel: 'M', margin: 2 });
}
