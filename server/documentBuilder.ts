import * as cheerio from 'cheerio';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import mammoth from 'mammoth';
import PDFDocument from 'pdfkit';
import { extractText, getDocumentProxy } from 'unpdf';
import { sanitizeFileName } from './security.ts';
import type { DeliverableFormat, TaskDeliverables, TaskRecord } from './types.ts';

const MAX_EXTRACTED_CHARS = 18000;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInlineHtml(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function markdownToSemanticHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.trim().startsWith('```')) {
      closeList();
      if (!inCode) {
        inCode = true;
        out.push('<pre><code>');
      } else {
        inCode = false;
        out.push('</code></pre>');
      }
      continue;
    }

    if (inCode) {
      out.push(`${escapeHtml(line)}\n`);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const h3 = trimmed.match(/^###\s+(.+)$/);
    if (h3) {
      closeList();
      out.push(`<h3>${formatInlineHtml(h3[1])}</h3>`);
      continue;
    }
    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      closeList();
      out.push(`<h2>${formatInlineHtml(h2[1])}</h2>`);
      continue;
    }
    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) {
      closeList();
      out.push(`<h1>${formatInlineHtml(h1[1])}</h1>`);
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (inList !== 'ul') {
        closeList();
        inList = 'ul';
        out.push('<ul>');
      }
      out.push(`<li>${formatInlineHtml(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (olMatch) {
      if (inList !== 'ol') {
        closeList();
        inList = 'ol';
        out.push('<ol>');
      }
      out.push(`<li>${formatInlineHtml(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${formatInlineHtml(trimmed)}</p>`);
  }

  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

export function buildHtmlBuffer(task: TaskRecord, deliverables: TaskDeliverables): Buffer {
  const customHtml = deliverables.deliverableHtml?.trim();
  if (customHtml && customHtml.length >= 120 && /<(html|body|div|section|main|h1|p|table)/i.test(customHtml)) {
    const fullDoc = /<!doctype\s+html/i.test(customHtml)
      ? customHtml
      : `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(task.title)}</title>
</head>
<body>
${customHtml}
</body>
</html>`;
    return Buffer.from(fullDoc, 'utf-8');
  }

  const bodyHtml = markdownToSemanticHtml(deliverables.homeworkSolutionMd);
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(task.title)} — ${escapeHtml(task.courseName)}</title>
  <style>
    :root { color-scheme: light; }
    body {
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      color: #0f172a;
      background: #ffffff;
      line-height: 1.65;
      max-width: 820px;
      margin: 40px auto;
      padding: 0 24px;
    }
    header {
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 16px;
      margin-bottom: 28px;
    }
    .meta {
      font-size: 13px;
      color: #475569;
      margin-bottom: 6px;
    }
    h1 { font-size: 24px; margin: 0 0 8px; line-height: 1.25; }
    h2 { font-size: 19px; margin-top: 28px; margin-bottom: 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
    h3 { font-size: 16px; margin-top: 20px; margin-bottom: 8px; }
    p { margin: 10px 0; }
    ul, ol { margin: 10px 0; padding-left: 24px; }
    li { margin: 5px 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
      background: #f1f5f9;
      padding: 2px 5px;
      border-radius: 4px;
    }
    pre {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.5;
    }
    pre code { background: transparent; padding: 0; }
    @media print {
      body { margin: 0; max-width: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="meta">${escapeHtml(task.courseName)}${task.dueDate ? ` · Entrega: ${escapeHtml(task.dueDate)}` : ''}</div>
    <h1>${escapeHtml(task.title)}</h1>
  </header>
  <main>
    ${bodyHtml}
  </main>
</body>
</html>`;

  return Buffer.from(html, 'utf-8');
}

function parseInlineRuns(text: string, isCode = false): TextRun[] {
  if (isCode) {
    return [new TextRun({ text, font: 'Courier New', size: 20 })];
  }
  const runs: TextRun[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      runs.push(new TextRun({ text: text.slice(lastIdx, match.index), size: 22 }));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true, size: 22 }));
    } else if (token.startsWith('`') && token.endsWith('`')) {
      runs.push(new TextRun({ text: token.slice(1, -1), font: 'Courier New', size: 20 }));
    }
    lastIdx = match.index + token.length;
  }

  if (lastIdx < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIdx), size: 22 }));
  }

  return runs.length > 0 ? runs : [new TextRun({ text, size: 22 })];
}

export async function buildDocxBuffer(
  task: TaskRecord,
  deliverables: TaskDeliverables
): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      text: task.courseName,
      spacing: { after: 80 },
      children: [new TextRun({ text: task.courseName, color: '475569', size: 20 })],
    }),
    new Paragraph({
      text: task.title,
      heading: HeadingLevel.TITLE,
      spacing: { after: 160 },
    }),
  ];

  if (task.dueDate) {
    children.push(
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun({ text: `Fecha límite: ${task.dueDate}`, color: '64748B', size: 20 })],
      })
    );
  }

  const lines = deliverables.homeworkSolutionMd.replace(/\r\n/g, '\n').split('\n');
  let inCode = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inCode = !inCode;
      continue;
    }

    if (inCode) {
      children.push(
        new Paragraph({
          children: parseInlineRuns(rawLine, true),
          spacing: { after: 60 },
          indent: { left: 360 },
        })
      );
      continue;
    }

    if (!trimmed) {
      children.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      continue;
    }

    const h3 = trimmed.match(/^###\s+(.+)$/);
    if (h3) {
      children.push(
        new Paragraph({
          text: h3[1].replace(/\*\*/g, ''),
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 180, after: 80 },
        })
      );
      continue;
    }

    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      children.push(
        new Paragraph({
          text: h2[1].replace(/\*\*/g, ''),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 100 },
        })
      );
      continue;
    }

    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) {
      children.push(
        new Paragraph({
          text: h1[1].replace(/\*\*/g, ''),
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 260, after: 120 },
        })
      );
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      children.push(
        new Paragraph({
          children: parseInlineRuns(ulMatch[1]),
          bullet: { level: 0 },
          spacing: { after: 80 },
        })
      );
      continue;
    }

    const olMatch = trimmed.match(/^(\d+[.)])\s+(.+)$/);
    if (olMatch) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${olMatch[1]} `, bold: true, size: 22 }),
            ...parseInlineRuns(olMatch[2]),
          ],
          indent: { left: 320 },
          spacing: { after: 80 },
        })
      );
      continue;
    }

    children.push(
      new Paragraph({
        children: parseInlineRuns(trimmed),
        alignment: AlignmentType.LEFT,
        spacing: { after: 120 },
      })
    );
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

export async function buildPdfBuffer(
  task: TaskRecord,
  deliverables: TaskDeliverables
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 52, bottom: 52, left: 52, right: 52 },
      info: {
        Title: task.title,
        Author: task.courseName,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica').fontSize(10).fillColor('#475569').text(task.courseName);
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#0F172A').text(task.title);
    if (task.dueDate) {
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(9.5).fillColor('#64748B').text(`Fecha límite: ${task.dueDate}`);
    }
    doc.moveDown(0.6);
    doc
      .strokeColor('#CBD5E1')
      .lineWidth(1)
      .moveTo(52, doc.y)
      .lineTo(543, doc.y)
      .stroke();
    doc.moveDown(0.8);

    const lines = deliverables.homeworkSolutionMd.replace(/\r\n/g, '\n').split('\n');
    let inCode = false;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('```')) {
        inCode = !inCode;
        doc.moveDown(0.25);
        continue;
      }

      if (inCode) {
        doc.font('Courier').fontSize(9.5).fillColor('#1E293B').text(rawLine || ' ', {
          indent: 14,
          lineGap: 2,
        });
        continue;
      }

      if (!trimmed) {
        doc.moveDown(0.35);
        continue;
      }

      const h3 = trimmed.match(/^###\s+(.+)$/);
      if (h3) {
        doc.moveDown(0.4);
        doc
          .font('Helvetica-Bold')
          .fontSize(12)
          .fillColor('#0F172A')
          .text(h3[1].replace(/\*\*/g, ''));
        doc.moveDown(0.2);
        continue;
      }

      const h2 = trimmed.match(/^##\s+(.+)$/);
      if (h2) {
        doc.moveDown(0.6);
        doc
          .font('Helvetica-Bold')
          .fontSize(14)
          .fillColor('#0F172A')
          .text(h2[1].replace(/\*\*/g, ''));
        doc.moveDown(0.25);
        continue;
      }

      const h1 = trimmed.match(/^#\s+(.+)$/);
      if (h1) {
        doc.moveDown(0.7);
        doc
          .font('Helvetica-Bold')
          .fontSize(16)
          .fillColor('#0F172A')
          .text(h1[1].replace(/\*\*/g, ''));
        doc.moveDown(0.3);
        continue;
      }

      const cleanText = trimmed.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
      const ulMatch = cleanText.match(/^[-*+]\s+(.+)$/);
      if (ulMatch) {
        doc
          .font('Helvetica')
          .fontSize(10.5)
          .fillColor('#1E293B')
          .text(`•  ${ulMatch[1]}`, { indent: 12, lineGap: 3 });
        continue;
      }

      doc.font('Helvetica').fontSize(10.5).fillColor('#1E293B').text(cleanText, { lineGap: 3 });
    }

    doc.end();
  });
}

export async function buildDeliverableFile(
  format: DeliverableFormat,
  task: TaskRecord,
  deliverables: TaskDeliverables
): Promise<{ fileName: string; mimeType: string; buffer: Buffer }> {
  const baseSlug = sanitizeFileName(task.title).slice(0, 60).replace(/\s+/g, '_');

  switch (format) {
    case 'html':
      return {
        fileName: `${baseSlug}_entrega.html`,
        mimeType: 'text/html',
        buffer: buildHtmlBuffer(task, deliverables),
      };
    case 'pdf':
      return {
        fileName: `${baseSlug}_entrega.pdf`,
        mimeType: 'application/pdf',
        buffer: await buildPdfBuffer(task, deliverables),
      };
    case 'docx':
      return {
        fileName: `${baseSlug}_entrega.docx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: await buildDocxBuffer(task, deliverables),
      };
    case 'md':
    default:
      return {
        fileName: '03_deberes_resueltos.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(deliverables.homeworkSolutionMd, 'utf-8'),
      };
  }
}

export async function extractTextFromUploadedFile(
  fileName: string,
  mimeType: string,
  buffer: Buffer
): Promise<string> {
  const lower = fileName.toLowerCase();

  try {
    if (lower.endsWith('.pdf') || mimeType === 'application/pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      return (text || '').trim().slice(0, MAX_EXTRACTED_CHARS);
    }

    if (
      lower.endsWith('.docx') ||
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim().slice(0, MAX_EXTRACTED_CHARS);
    }

    if (lower.endsWith('.html') || lower.endsWith('.htm') || mimeType.includes('text/html')) {
      const html = buffer.toString('utf-8');
      const $ = cheerio.load(html);
      $('script, style, noscript').remove();
      return $('body')
        .text()
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, MAX_EXTRACTED_CHARS);
    }

    if (
      mimeType.startsWith('text/') ||
      lower.endsWith('.txt') ||
      lower.endsWith('.md') ||
      lower.endsWith('.csv') ||
      lower.endsWith('.json')
    ) {
      return buffer.toString('utf-8').trim().slice(0, MAX_EXTRACTED_CHARS);
    }
  } catch {
    // Non-fatal extraction error
  }

  return '';
}
