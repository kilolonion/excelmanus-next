// 外观偏好（02 §7 外观）：主题与字号只存本地（界面偏好，13 §1.1），不进服务端设置。

export type ThemePref = "system" | "light" | "dark";
const THEME_KEY = "excelmanus.theme";
const FONT_KEY = "excelmanus.fontSize";

export function getTheme(): ThemePref {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function getFontSize(): number {
  const n = Number(localStorage.getItem(FONT_KEY));
  return n >= 12 && n <= 18 ? n : 14;
}

const media =
  typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;

export function applyAppearance(): void {
  const pref = getTheme();
  const dark = pref === "dark" || (pref === "system" && media?.matches === true);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.setProperty("--base-font", `${getFontSize()}px`);
}

export function setTheme(t: ThemePref): void {
  localStorage.setItem(THEME_KEY, t);
  applyAppearance();
}

export function setFontSize(n: number): void {
  localStorage.setItem(FONT_KEY, String(n));
  applyAppearance();
}

media?.addEventListener("change", () => applyAppearance());
