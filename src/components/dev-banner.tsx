export function DevBanner() {
  return (
    <div className="bg-primary text-primary-foreground px-4 py-2 text-center text-sm">
      <span className="font-medium">OpenRFP is in active development</span>
      <span className="ml-2 opacity-90">
        — not fully functional yet. Core features may be incomplete or change.
      </span>
    </div>
  );
}
