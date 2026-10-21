# 一代品牌图标接入（2026-10-01）

用户明确要求从桌面 `excelmanus` 提取一代 logo 用于 Next。只读取品牌素材，未参考或复制旧实现代码；原始素材保持不变。

## 来源与实现

- 来源：`~/Desktop/excelmanus/web/public/icon.png`，1254 × 1254 透明 PNG，绿色手持表格图案。
- 处理：ImageMagick 缩放至 256 × 256 并移除附加元数据，不重绘图案；输出 `packages/web/public/brand-icon.png` 和 `favicon.png`，每个 42,841 字节。
- 应用：侧栏（28px）、连接中／连接失败／退出登录页面（40px）、浏览器 favicon；组件统一位于 `packages/web/src/components/Icon.tsx`。
- 原始 SHA-256：`9e8e3b558d72c000d9db7ab1a07eb4a0869eeb9489b52d19f16225afe392bfb8`。
- 两个输出的 SHA-256：`c24a1edf9a6b4e1cdb1916fe3e3802268199e0a72768668a7fe408ab10d4d8b4`。

## 已执行检查

环境：macOS，Node 24.1.0，pnpm 10.11.0；仓库现有未提交变更保留。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Web 类型检查 | 通过 | `pnpm --filter @excelmanus/web typecheck`，退出码 0 |
| 变更文件格式与 lint | 通过 | `pnpm exec biome check packages/web/src/App.tsx packages/web/src/components/Icon.tsx packages/web/src/components/SessionList.tsx packages/web/index.html`，退出码 0 |
| 界面约定 | 通过 | `pnpm exec vitest run packages/web/test/ui-conventions.test.ts`，1 file / 4 tests 通过 |
| Web 生产构建 | 通过 | `pnpm build:web`，退出码 0；3822 modules，生成 `dist/brand-icon.png`、`dist/favicon.png` |
| 静态资源完整性 | 通过 | 两个 public 文件分别与 dist 文件逐字节 `cmp` 相等 |
| 素材目视检查 | 已执行 | 查看输出 `packages/web/public/brand-icon.png`，透明底、图案比例保留 |

## 边界

未执行浏览器中浅色／深色页面实机复核，也未修改桌面应用包图标或重新打包桌面程序。本次检查不作为整个里程碑验收。构建仍输出依赖注释、动态导入及大块体积警告，未影响构建完成。
