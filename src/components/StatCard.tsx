interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
}

export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <div className="border-t border-border pt-3">
      <p className="text-xs text-foreground-muted">{label}</p>
      <p className="mt-1 font-display text-3xl font-medium tabular-nums text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-foreground-muted">{hint}</p> : null}
    </div>
  );
}
