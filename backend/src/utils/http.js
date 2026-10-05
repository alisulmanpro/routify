export const ok = (data, meta) => (meta ? { success: true, data, meta } : { success: true, data });

export function paginate(query) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export const pageMeta = (page, limit, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });

export const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const todayKey = (date = new Date()) => date.toISOString().slice(0, 10);

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
