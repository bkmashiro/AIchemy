interface AuditEntry {
  timestamp: string;
  action: string;  // "task.create", "task.kill", "stub.purge", etc.
  details: Record<string, any>;
}

const MAX_AUDIT_ENTRIES = 1000;
const auditLog: AuditEntry[] = [];

export function logAudit(action: string, details: Record<string, any>): void {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    action,
    details,
  };
  auditLog.push(entry);
  // Ring buffer: keep last MAX_AUDIT_ENTRIES
  if (auditLog.length > MAX_AUDIT_ENTRIES) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT_ENTRIES);
  }
}

export function getAuditLog(limit?: number): AuditEntry[] {
  if (limit !== undefined && limit > 0) {
    return auditLog.slice(-limit);
  }
  return auditLog.slice();
}

/** Reset audit log (for testing). */
export function resetAuditLog(): void {
  auditLog.splice(0, auditLog.length);
}
