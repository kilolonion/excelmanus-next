// 外观偏好：只存本地（界面偏好，不进服务端设置）。深色主题经 <html class="dark"> 套用一代样式体系。

export type ThemePref = "system" | "light" | "dark";
const THEME_KEY = "excelmanus.theme";

const media =
  typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;

export function getTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function isDarkTheme(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function applyTheme(): void {
  const pref = getTheme();
  const dark = pref === "dark" || (pref === "system" && media?.matches === true);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function setTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // 存储不可用时只影响本次
  }
  applyTheme();
}

media?.addEventListener("change", () => applyTheme());
