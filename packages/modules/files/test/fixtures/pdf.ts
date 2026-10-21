/** Tiny deterministic PDF fixtures; no third-party document or private content. */
export function samplePdf(image?: Buffer): Buffer {
  const pages = 2;
  const fontId = 7, imageId = 8;
  const objects: Buffer[] = [];
  const str = (text: string) => Buffer.from(text, "ascii");
  objects.push(str("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(str("<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"));
  for (let i = 0; i < pages; i++) {
    const content = image && i === 0 ? "q 260 0 0 80 10 100 cm /Im0 Do Q" : `BT /F1 18 Tf 20 150 Td (Page ${i + 1}: total 46.00) Tj ET`;
    objects.push(str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${fontId} 0 R >> ${image ? `/XObject << /Im0 ${imageId} 0 R >>` : ""} >> /Contents ${4 + i * 2} 0 R >>`));
    objects.push(str(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`));
  }
  objects.push(str("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  if (image) objects.push(Buffer.concat([str(`<< /Type /XObject /Subtype /Image /Width 260 /Height 80 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, str("\nendstream")]));
  const parts = [str("%PDF-1.4\n")]; const offsets = [0]; let size = parts[0]!.length;
  objects.forEach((object, index) => { offsets.push(size); const part = Buffer.concat([str(`${index+1} 0 obj\n`), object, str("\nendobj\n")]); parts.push(part); size += part.length; });
  parts.push(str(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(o=>`${String(o).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}
