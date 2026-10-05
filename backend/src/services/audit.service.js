import { AuditLog } from '../models/audit-log.js';
import { logger } from '../utils/logger.js';

/** Never throws: auditing must not break the request it describes. */
export async function audit(actor, action, { targetType = null, targetId = null, status = 'success', meta = null, ip = null } = {}) {
  try {
    await AuditLog.create({ actorId: actor?.id || null, actorEmail: actor?.email || null, action, targetType, targetId: targetId ? String(targetId) : null, status, meta, ip });
  } catch (error) {
    logger.error({ err: error, action }, 'Failed to write audit log');
  }
}

export const actorFrom = (req) => ({ actor: req.user, ip: req.ip });
