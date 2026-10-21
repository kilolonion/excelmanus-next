import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Loader2 } from "lucide-react";
import { Popover } from "radix-ui";
import { useRef, useState } from "react";
import { ModelListBottomSheet } from "@/components/chat/ModelListBottomSheet";
import {
  hasProviderLogo,
  ProviderLogo,
  providerFallbackInitial,
} from "@/components/settings/model/ProviderLogo";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { useModelSelection } from "@/hooks/use-model-selection";
import { getProviderColor, getProviderDisplayName } from "@/lib/provider-brand";
import { useChatStore } from "@/stores/chat-store";
import { useUIStore } from "@/stores/ui-store";
import { ModelPickerContent } from "./ModelPickerContent";
import styles from "./ModelPickerContent.module.css";

function ModelBrandMark({
  brand,
  label,
  unhealthy,
}: {
  brand: string;
  label: string;
  unhealthy: boolean;
}) {
  const color = getProviderColor(brand);
  return (
    <span
      className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center"
      aria-hidden="true"
    >
      {hasProviderLogo(brand) ? (
        <ProviderLogo id={brand} color={color} className="h-4 w-4" />
      ) : (
        <span
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold leading-none"
          style={{ color, backgroundColor: `${color}18` }}
        >
          {providerFallbackInitial(label)}
        </span>
      )}
      {unhealthy && (
        <span className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full border border-card bg-[var(--em-error)]" />
      )}
    </span>
  );
}

export function TopModelSelector() {
  const { currentModel, models, switching, loading, loadError, switchError, reload, selectModel } =
    useModelSelection();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isMobile = useIsMobile();

  const sessionLoading = useChatStore((s) => s.loading);
  const sessionError = useChatStore((s) => !!s.loadError);
  const active = models.find((model) => model.id === currentModel);
  const displayName =
    sessionLoading || (loading && !models.length)
      ? "正在加载模型"
      : sessionError || (loadError && !models.length)
        ? "模型待确认"
        : (active?.label ?? "选择模型");
  const pickerProps = {
    models,
    currentModel,
    switching,
    loading,
    loadError,
    switchError,
    onSelect: async (id: string) => {
      if (await selectModel(id)) setOpen(false);
    },
    onClose: () => setOpen(false),
    onReload: () => void reload(),
  };
  const trigger = (
    <Button
      ref={triggerRef}
      disabled={sessionLoading || sessionError}
      variant="ghost"
      className="em-model-selector-trigger gap-1.5 px-2.5 h-8 rounded-full border border-[var(--em-line)] bg-card/80 text-[12px] font-medium text-muted-foreground group shrink-0 shadow-sm hover:border-[var(--em-line-strong)] data-[state=open]:bg-[var(--em-primary-alpha-06)] data-[state=open]:border-[var(--em-primary-alpha-25)]"
      data-coach-id="coach-model-selector"
      aria-label={`选择模型：${displayName}`}
      title={active ? `${displayName} · ${active.profileName}` : displayName}
      aria-haspopup={isMobile ? "dialog" : undefined}
      aria-expanded={isMobile ? open : undefined}
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      <ModelBrandMark
        brand={active?.brand ?? "unknown"}
        label={active ? getProviderDisplayName(active.brand) : displayName}
        unhealthy={active?.unhealthy ?? false}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={currentModel || "_none"}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
          className={`em-model-selector-label truncate ${active?.unhealthy ? "text-destructive" : ""}`}
        >
          {displayName}
        </motion.span>
      </AnimatePresence>
      {switching || sessionLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : (
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
      )}
    </Button>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <ModelListBottomSheet
          {...pickerProps}
          open={open}
          onOpenChange={setOpen}
          mode="switch"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!useUIStore.getState().settingsOpen) triggerRef.current?.focus();
          }}
        />
      </>
    );
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void reload();
      }}
    >
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className={styles.popover}
          aria-label="选择模型"
          onCloseAutoFocus={(event) => {
            if (useUIStore.getState().settingsOpen) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>("input")?.focus();
          }}
        >
          <ModelPickerContent {...pickerProps} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
