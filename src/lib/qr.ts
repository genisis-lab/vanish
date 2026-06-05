import QRCode from "qrcode"

export async function toQrDataUrl(text: string, dark: boolean): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    scale: 6,
    color: dark
      ? { dark: "#f5f5f4", light: "#00000000" }
      : { dark: "#1c1917", light: "#00000000" },
  })
}
