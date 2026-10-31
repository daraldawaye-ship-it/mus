/**
 * Generate a real PDF entirely on the user's device, also from installed
 * iOS/Android PWAs. Arabic is drawn with the browser's own font shaping, then
 * each A4 page is embedded as a JPEG image in a small PDF 1.4 document.
 * No CDN, remote renderer, fonts download, or browser print dialog required.
 */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const SCALE = 2;
const PAGE_MARGIN = 25;
const COLUMN_GAP = 20;
const COLUMN_WIDTH = (PAGE_WIDTH - PAGE_MARGIN * 2 - COLUMN_GAP) / 2;
const LINE_HEIGHT = 14;
const ITEM_GAP = 5;

type PdfPage = { jpeg: Uint8Array; width: number; height: number };

function wrapName(
  ctx: CanvasRenderingContext2D, name: string, maxWidth: number,
): string[] {
  const words = name.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (ctx.measureText(word).width <= maxWidth) {
      current = word;
      continue;
    }
    // Very long product codes/words must not be clipped on phone or desktop.
    let chunk = "";
    for (const character of Array.from(word)) {
      if (chunk && ctx.measureText(chunk + character).width > maxWidth) {
        lines.push(chunk);
        chunk = character;
      } else {
        chunk += character;
      }
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makePdf(pages: PdfPage[]): Blob {
  if (!pages.length) throw new Error("لا توجد أصناف لتصديرها.");
  const parts: Uint8Array[] = [];
  const offsets: number[] = [0];
  let length = 0;
  const write = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? toBytes(part) : part;
    parts.push(bytes);
    length += bytes.length;
  };
  const startObject = (n: number) => {
    offsets[n] = length;
    write(`${n} 0 obj\n`);
  };
  write("%PDF-1.4\n% Item names two-column list\n");
  startObject(1);
  write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  startObject(2);
  write(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>\nendobj\n`);
  for (const [i, page] of pages.entries()) {
    const pageObject = 3 + 3 * i;
    const contentObject = pageObject + 1;
    const imageObject = pageObject + 2;
    startObject(pageObject);
    write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>\nendobj\n`);
    const contents = `q\n${PAGE_WIDTH} 0 0 ${PAGE_HEIGHT} 0 0 cm\n/Im0 Do\nQ\n`;
    startObject(contentObject);
    write(`<< /Length ${toBytes(contents).length} >>\nstream\n${contents}endstream\nendobj\n`);
    startObject(imageObject);
    write(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`);
    write(page.jpeg);
    write("\nendstream\nendobj\n");
  }
  const xrefPosition = length;
  const count = 3 + pages.length * 3;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) {
    write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return new Blob([bytes.buffer], { type: "application/pdf" });
}

function canvasJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async blob => {
      if (!blob) {
        reject(new Error("تعذر إنشاء صفحة PDF في متصفح الهاتف."));
        return;
      }
      try {
        resolve(new Uint8Array(await blob.arrayBuffer()));
      } catch (reason) { reject(reason); }
    }, "image/jpeg", 0.85);
  });
}

export async function createTwoColumnItemNamesPdf(names: string[]): Promise<Blob> {
  const list = names.map(name => name.trim()).filter(Boolean);
  if (!list.length) throw new Error("لم يتم اختيار أي صنف.");
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(PAGE_WIDTH * SCALE);
  canvas.height = Math.round(PAGE_HEIGHT * SCALE);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("متصفح الجهاز لا يدعم إنشاء صفحات PDF.");
  const pages: PdfPage[] = [];
  const drawBlank = () => {
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    ctx.fillStyle = "#111";
    ctx.font = '11px Tahoma, Arial, "Noto Naskh Arabic", sans-serif';
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.direction = "rtl";
  };
  drawBlank();
  let column = 0;
  let y = PAGE_MARGIN;
  const flushPage = async () => {
    pages.push({jpeg:await canvasJpeg(canvas),width:canvas.width,height:canvas.height});
  };
  try {
    for (const name of list) {
      const lines = wrapName(ctx, name, COLUMN_WIDTH - 6);
      const height = lines.length * LINE_HEIGHT + ITEM_GAP;
      if (y + height > PAGE_HEIGHT - PAGE_MARGIN && column === 0) {
        column = 1;
        y = PAGE_MARGIN;
      } else if (y + height > PAGE_HEIGHT - PAGE_MARGIN) {
        await flushPage();
        drawBlank();
        column = 0;
        y = PAGE_MARGIN;
      }
      const right = column === 0
        ? PAGE_WIDTH - PAGE_MARGIN
        : PAGE_WIDTH - PAGE_MARGIN - COLUMN_WIDTH - COLUMN_GAP;
      for (const line of lines) {
        ctx.fillText(line, right, y, COLUMN_WIDTH - 6);
        y += LINE_HEIGHT;
      }
      y += ITEM_GAP;
    }
    await flushPage();
    return makePdf(pages);
  } finally {
    // Release canvas bitmap memory on low-RAM installed mobile apps.
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function exportPdfToDevice(blob: Blob, filename: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([blob], filename, { type: "application/pdf" });
  // The native share sheet exposes "Save to Files" on iPhone and equivalent
  // save/share targets on Android; works inside many installed PWAs.
  const native = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  const prefersNativeShare = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (prefersNativeShare && native.share && native.canShare?.({ files: [file] })) {
    try {
      await native.share({ files: [file], title: filename });
      return "shared";
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError")
        return "cancelled";
      // Sharing can be blocked by the PWA/browser: fall back to real download.
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return "downloaded";
}
