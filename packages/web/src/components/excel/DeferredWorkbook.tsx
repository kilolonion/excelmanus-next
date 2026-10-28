import { LazyRegion } from "@/components/ui/LazyRegion";
import { loadWorkbookSurface } from "@/lib/workbook/load-surface";
import { setPanelOpen } from "@/stores/workbook-store";

export function DeferredWorkbook({ placement }: { placement: "full" | "panel" }) {
  return (
    <LazyRegion
      load={loadWorkbookSurface}
      componentProps={{ placement }}
      label="表格工作区"
      onClose={() => setPanelOpen(false)}
    />
  );
}
