import { presetBrand, providerLogoSlug } from "@/lib/provider-brand";

/** 供应商图标（public/providers/*.svg，按预设 id 识别品牌）。 */
export function ProviderMark({ id }: { id: string }) {
  const slug = providerLogoSlug(presetBrand(id));
  if (!slug) return null;
  return (
    <span
      className="inline-block h-7 w-7 shrink-0"
      role="img"
      aria-label={`${id} logo`}
      style={{
        backgroundColor: "currentColor",
        maskImage: `url(/providers/${slug}.svg)`,
        WebkitMaskImage: `url(/providers/${slug}.svg)`,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}
