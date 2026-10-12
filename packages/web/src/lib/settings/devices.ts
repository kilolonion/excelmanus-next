// 设备（访问令牌）管理。
import type { Device } from "@excelmanus/protocol";
import { api } from "@/lib/backend/api";

export async function listDevices(): Promise<Device[]> {
  return (await api().listDevices()).items;
}

export async function revokeDevice(id: string): Promise<void> {
  await api().revokeDevice(id);
}
