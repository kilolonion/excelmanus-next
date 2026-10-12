// 与后端断开时的顶部细条（02 §9）；恢复后同步通道自行续传。短暂抖动（< 1 秒）不提示。

import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useAppStore } from "@/stores/app-store";

export function ReconnectBar() {
  const lost = useAppStore((s) => s.everConnected && !s.connected);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!lost) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 1000);
    return () => clearTimeout(timer);
  }, [lost]);

  if (!visible) return null;
  return (
    <div role="status" aria-live="polite" className="em-reconnect-bar">
      <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
      正在重新连接…
    </div>
  );
}
