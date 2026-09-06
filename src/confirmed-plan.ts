interface RefSnapshot { id: string; sourceSha: string | null; targetSha: string | null }

// Compact tuples fit the host's bounded, persisted string input contract.
// Repository/source/target refs are derived from environment + item by the
// pinned plugin revision; only exact full SHAs cross the confirmation boundary.
export function confirmedPlan(environment: "preprod" | "prod", selected: string[], services: RefSnapshot[]): string {
  const rows = selected.map((id) => {
    const service = services.find((item) => item.id === id);
    if (!service?.sourceSha || !/^[0-9a-f]{40}$/.test(service.sourceSha) || (service.targetSha !== null && !/^[0-9a-f]{40}$/.test(service.targetSha))) throw new Error("Collect a new complete SHA snapshot before confirming");
    return [id, service.sourceSha, service.targetSha];
  });
  const value = JSON.stringify({ version: 1, environment, services: rows });
  if (value.length > 20_000) throw new Error("Select fewer services for this confirmed plan");
  return value;
}
