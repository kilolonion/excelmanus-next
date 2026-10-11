// Univer 主题：主色与灰阶取自应用 token（玉绿 #16735d、偏绿冷灰），
// 让选区、列头高亮、工作表标签与公式栏和应用其余部分一致。深色模式由 Univer 按灰阶反转。

import { defaultTheme, type Theme } from "@univerjs/presets";

export const jadeTheme: Theme = {
  ...defaultTheme,
  primary: {
    50: "#EEF7F3",
    100: "#DDEFE7",
    200: "#BEE1D2",
    300: "#94CDB6",
    400: "#4FA88A",
    500: "#24896F",
    600: "#16735D",
    700: "#125F4D",
    800: "#0F4C3E",
    900: "#0B3A2F",
  },
  gray: {
    0: "#FFFFFF",
    50: "#F7F9F8",
    100: "#EEF2F0",
    200: "#E4EBE8",
    300: "#B4C2BB",
    400: "#84958C",
    500: "#55655D",
    600: "#36443D",
    700: "#28332E",
    800: "#1F2925",
    900: "#18211E",
    1000: "#000000",
  },
};
