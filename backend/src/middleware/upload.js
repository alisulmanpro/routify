import multer from 'multer';
import { AppError, unprocessable } from '../utils/errors.js';

const build = (field, maxBytes, mimes, extensions = []) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 20 },
    fileFilter: (_req, file, cb) => {
      const mime = String(file.mimetype || '').toLowerCase();
      const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
      const acceptsMime = mimes.includes(mime);
      const acceptsExtension = !!ext && extensions.includes(ext);
      const acceptsJpegAlias = mime === 'image/jpg' && (ext === 'jpg' || ext === 'jpeg');
      if (acceptsMime || acceptsExtension || acceptsJpegAlias) return cb(null, true);
      return cb(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Only ${mimes.join(', ')} files are accepted`));
    },
  }).single(field);

export const uploadPhoto = build('photo', 8 * 1024 * 1024, ['image/jpeg', 'image/jpg', 'image/png'], ['jpg', 'jpeg', 'png']);
export const uploadPdf = build('file', 10 * 1024 * 1024, ['application/pdf'], ['pdf']);
export const uploadDocument = build('file', 10 * 1024 * 1024, [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv'
], ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv']);

const SIGNATURES = {
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};

/** Never trust the client's mimetype: verify the magic bytes and return the canonical extension. */
export function detectFileType(buffer, allowed) {
  if (!buffer?.length) throw unprocessable('No file was uploaded', 'FILE_REQUIRED');
  const kind = allowed.find((ext) => SIGNATURES[ext](buffer));
  if (!kind) throw new AppError(415, 'INVALID_FILE', 'The uploaded file content does not match an allowed type');
  return kind;
}

/** Detect document type from extension + basic content validation. */
export function detectDocumentType(buffer, originalname) {
  if (!buffer?.length) throw unprocessable('No file was uploaded', 'FILE_REQUIRED');
  const ext = (originalname || '').split('.').pop()?.toLowerCase();
  const allowed = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv'];
  if (!ext || !allowed.includes(ext)) throw new AppError(415, 'UNSUPPORTED_FILE', 'Unsupported file type');
  
  // Basic validation
  if (ext === 'pdf' && buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new AppError(415, 'INVALID_FILE', 'File does not appear to be a valid PDF');
  if ((ext === 'docx' || ext === 'xlsx') && !(buffer[0] === 0x50 && buffer[1] === 0x4B)) throw new AppError(415, 'INVALID_FILE', 'File does not appear to be a valid Office document');
  if ((ext === 'doc' || ext === 'xls') && !(buffer[0] === 0xD0 && buffer[1] === 0xCF)) throw new AppError(415, 'INVALID_FILE', 'File does not appear to be a valid Office document');
  
  return ext;
}
