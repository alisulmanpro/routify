const TONE: Record<string, string> = {
  active: 'green', delivered: 'green', succeeded: 'green', collected: 'green',
  pending: 'amber', trialing: 'amber', in_progress: 'blue', not_required: 'muted',
  suspended: 'red', failed: 'red', expired: 'red', cancelled: 'muted', past_due: 'amber', refunded: 'muted', inactive: 'muted',
};
export default function StatusBadge({ value }: { value: string }) {
  const tone = TONE[value] || 'muted';
  return <span className={`status-badge tone-${tone}`}>{value.replace(/_/g, ' ')}</span>;
}
