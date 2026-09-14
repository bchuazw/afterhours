import { isDeployed } from "@/lib/deployment";

export function NotDeployedBanner() {
  if (isDeployed) return null;
  return (
    <div className="border-b border-warn/30 bg-warn/10">
      <div className="mx-auto flex max-w-6xl items-start gap-3 px-4 py-2.5 text-sm sm:px-6">
        <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-warn" />
        <p className="leading-relaxed text-fg/90">
          <span className="font-medium text-warn">Contracts not deployed yet.</span>{" "}
          <span className="text-muted">
            <code className="num text-xs">src/deployments.json</code> still has zero addresses, so live quotes, vault
            stats and positions are unavailable. Deploy the contracts, paste the addresses in, and rebuild.
          </span>
        </p>
      </div>
    </div>
  );
}
