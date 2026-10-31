/**
 * Generate a real PDF entirely on the user's device, also from installed
 * iOS/Android PWAs. Arabic is drawn with the browser's own font shaping, then
 * each A4 page is embedded as a JPEG image in a small PDF 1.4 document.
 * No CDN, remote renderer, fonts download, or browser print dialog required.
 */
// Same measurements as the .item-options-print-* @media print rules in styles.css.
// A4 points (72 pt/in), 12 mm top/bottom, 10 mm sides, 7 mm column gap.
const MM_TO_PT = 72 / 25.4;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const SCALE = 2;
const PAGE_MARGIN_X = 10 * MM_TO_PT;
const PAGE_MARGIN_Y = 12 * MM_TO_PT;
const COLUMN_GAP = 7 * MM_TO_PT;
const COLUMN_WIDTH = (PAGE_WIDTH - 2 * PAGE_MARGIN_X - COLUMN_GAP) / 2;
const LINE_HEIGHT = 9 * 1.35; // print CSS font-size:9pt; line-height:1.35
const ROW_PADDING = 1.2 * MM_TO_PT; // print CSS padding:1.2mm 0
const ROW_BORDER = 0.5;
const PAGE_CONTENT_HEIGHT = PAGE_HEIGHT - 2 * PAGE_MARGIN_Y;

type PdfPage = { jpeg: Uint8Array; width: number; height: number };
type PreparedRow = { lines: string[]; height: number };

/**
 * First fill up to two page-height columns, then balance that page by row
 * height. This mirrors CSS column-fill: balance: even five selected items
 * should begin in BOTH columns, not occupy only one tall column.
 */
export function balanceItemNamesColumns(
  heights: readonly number[], capacity: number,
): Array<{ start: number; split: number; end: number }> {
  const pages: Array<{ start: number; split: number; end: number }> = [];
  let start = 0;
  while (start < heights.length) {
    let end = start;
    for (let col = 0; col < 2; col++) {
      let used = 0;
      while (end < heights.length &&
        (used + heights[end] <= capacity || used === 0 && heights[end] > capacity)) {
        used += heights[end];
        end++;
      }
    }
    if (end === start) end++;
    let split = end;
    if (end > start + 1) {
      const sum = heights.slice(start, end).reduce((a, b) => a + b, 0);
      let first = 0;
      let best = Number.POSITIVE_INFINITY;
      for (let i = start + 1; i < end; i++) {
        first += heights[i - 1];
        const second = sum - first;
        if (first > capacity || second > capacity) continue;
        const score = Math.abs(first - second);
        if (score < best) {
          best = score;
          split = i;
        }
      }
      // Fallback to the original greedy first column if rows are unusually tall.
      if (split === end) {
        let used = 0;
        for (let i = start; i < end; i++) {
          if (used + heights[i] > capacity) { split = i; break; }
          used += heights[i];
        }
      }
    }
    pages.push({ start, split, end });
    start = end;
  }
  return pages;
}

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

function canvasJpeg(canvas: HTMLCanvasElement): Uint8Array {
  // Synchronous encoding keeps mobile browser user activation alive until the
  // native share sheet is opened (iOS/Android installed app included).
  const data = canvas.toDataURL("image/jpeg", 0.85);
  const comma = data.indexOf(",");
  if (!data.startsWith("data:image/jpeg;base64,") || comma < 0)
    throw new Error("تعذر إنشاء صورة صفحة PDF على هذا الجهاز.");
  const raw = atob(data.slice(comma + 1));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function createTwoColumnItemNamesPdf(names: string[]): Blob {
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
    // Coordinates are already PDF points: 9 px on canvas = 9 pt in the PDF.
    ctx.font = '9px Tahoma, Arial, "Noto Naskh Arabic", sans-serif';
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.direction = "rtl";
  };
  const drawColumn = (rows: PreparedRow[], isRight: boolean): number => {
    const right = isRight
      ? PAGE_WIDTH - PAGE_MARGIN_X
      : PAGE_MARGIN_X + COLUMN_WIDTH;
    const left = right - COLUMN_WIDTH;
    let y = PAGE_MARGIN_Y;
    for (const row of rows) {
      let textY = y + ROW_PADDING;
      for (const line of row.lines) {
        ctx.fillStyle = "#111";
        ctx.fillText(line, right, textY, COLUMN_WIDTH);
        textY += LINE_HEIGHT;
      }
      y += row.height;
      // Same subtle dotted line between items as the printed HTML rows.
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([1.3, 2.1]);
      ctx.lineWidth = ROW_BORDER;
      ctx.strokeStyle = "#bbb";
      ctx.moveTo(left, y - ROW_BORDER / 2);
      ctx.lineTo(right, y - ROW_BORDER / 2);
      ctx.stroke();
      ctx.restore();
    }
    return y;
  };
  const flushPage = () => {
    pages.push({ jpeg: canvasJpeg(canvas), width: canvas.width, height: canvas.height });
  };
  try {
    drawBlank();
    const prepared = list.map(name => {
      const lines = wrapName(ctx, name, COLUMN_WIDTH);
      return { lines, height: lines.length * LINE_HEIGHT + 2 * ROW_PADDING + ROW_BORDER };
    });
    const pageGroups = balanceItemNamesColumns(
      prepared.map(row => row.height), PAGE_CONTENT_HEIGHT,
    );
    for (const [index, group] of pageGroups.entries()) {
      if (index) drawBlank();
      // Right-to-left reading order, identical to dir=rtl in the print sheet.
      const rightBottom = drawColumn(prepared.slice(group.start, group.split), true);
      const leftBottom = drawColumn(prepared.slice(group.split, group.end), false);
      if (group.split < group.end) {
        ctx.save();
        ctx.strokeStyle = "#ddd";
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(PAGE_WIDTH / 2, PAGE_MARGIN_Y);
        ctx.lineTo(PAGE_WIDTH / 2, Math.max(rightBottom, leftBottom));
        ctx.stroke();
        ctx.restore();
      }
      flushPage();
    }
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
