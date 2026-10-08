import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { Delivery } from '../models/delivery.js';
import { detectDocumentType } from '../middleware/upload.js';
import { unprocessable } from '../utils/errors.js';
import { assertCanCreateDeliveries } from './subscription.service.js';
import { extractDeliveriesFromText } from './pdf-import.service.js';

async function extractTextFromPdf(buffer) {
  let text, pages;
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    text = result.text || '';
    pages = result.total;
  } catch {
    throw unprocessable('This PDF could not be read. Check that the file is a valid, unprotected PDF.', 'INVALID_PDF');
  } finally {
    await parser.destroy().catch(() => {});
  }
  if (pages > 100) throw unprocessable('PDFs longer than 100 pages are not supported', 'PDF_TOO_LARGE');
  return text;
}

async function extractTextFromWord(buffer, ext) {
  if (ext === 'doc') {
    throw unprocessable('The older .doc format is not supported. Please open the file in Word and save it as a .docx document.', 'UNSUPPORTED_DOC');
  }
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  } catch {
    throw unprocessable('This Word document could not be read. Check that it is a valid .docx file.', 'INVALID_DOCX');
  }
}

function extractFromExcel(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw unprocessable('This spreadsheet could not be read. Check that it is a valid Excel or CSV file.', 'INVALID_SPREADSHEET');
  }
  // Combine all sheets
  const lines = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    for (const row of rows) {
      const line = row.map((cell) => String(cell ?? '').trim()).filter(Boolean).join('  ');
      if (line) lines.push(line);
    }
  }
  return lines.join('\n');
}

function extractFromCsv(buffer) {
  // CSV is just a special case of Excel parsing in xlsx
  return extractFromExcel(buffer);
}

export async function buildDraftFromFile(actor, file) {
  const ext = detectDocumentType(file?.buffer, file?.originalname);
  await assertCanCreateDeliveries(actor, 1);

  let text;
  switch (ext) {
    case 'pdf':
      text = await extractTextFromPdf(file.buffer);
      break;
    case 'docx':
    case 'doc':
      text = await extractTextFromWord(file.buffer, ext);
      break;
    case 'xlsx':
    case 'xls':
      text = extractFromExcel(file.buffer);
      break;
    case 'csv':
      text = extractFromCsv(file.buffer);
      break;
    default:
      throw unprocessable('Unsupported file type', 'UNSUPPORTED_FILE');
  }

  if (!text.trim()) throw unprocessable('No text found in this file. Try a different file or add deliveries manually.', 'FILE_NO_TEXT');

  const items = extractDeliveriesFromText(text);
  if (!items.length) throw unprocessable('No deliveries were recognised in this file. Add them manually instead.', 'FILE_NO_DELIVERIES');

  const existing = new Set((await Delivery.find({ riderId: actor.id, trackingId: { $in: items.map((i) => i.trackingId) } }).select('trackingId').lean()).map((d) => d.trackingId));
  const seen = new Set();
  for (const item of items) {
    if (existing.has(item.trackingId) || seen.has(item.trackingId)) item.flags.push('duplicate');
    seen.add(item.trackingId);
  }
  return { fileType: ext, items };
}

