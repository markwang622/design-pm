export function caseEditPermission(user, row, patch = {}) {
  if (user.role === 'observer') return 'read_only';
  if (user.role === 'admin') return null;
  const primary = row.designerId === user.id;
  const collab = row.collaborators?.some(s => s.id === user.id);
  if (!primary && !collab) return 'not_assigned';
  if (['done','closed'].includes(patch.status)) return 'closed_admin_only';
  if (collab && !primary && (
    (patch.designerId !== undefined && patch.designerId !== row.designerId) ||
    (patch.collaboratorIds !== undefined && [...patch.collaboratorIds].sort().join(',') !== row.collaborators.map(s=>s.id).sort().join(',')) ||
    patch.status === 'cancelled'
  )) return 'assignment_primary_only';
  return null;
}
