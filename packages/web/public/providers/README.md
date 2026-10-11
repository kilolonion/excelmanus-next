# 提供商品牌素材

2026-10-02 按用户明确要求导入一代项目 `excelmanus/web/public/providers/` 的 22 个 SVG；只复用素材，不复用实现代码。原项目 Apache-2.0 许可文本保存在 `LICENSE-excelmanus`。部分素材为 Simple Icons 品牌路径，其上游许可与说明见 [LICENSE](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md)、[DISCLAIMER](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md)；商标仍属于对应品牌。

一代缺少 Ollama；一代 `x.svg` 实际为 X.Org，未导入。`ollama.svg` 与 `xai.svg` 来自 [Lobe Icons](https://github.com/lobehub/lobe-icons) 的静态 SVG，MIT 许可文本保存在 `LICENSE-lobe-icons`。

`sources.json` 保存每个素材的直接来源与最终 SHA-256。对缺少标题的 SVG 补充可访问性 `title`，图形路径保持原样。所有图标本地加载，不使用运行时 CDN，也不增加依赖。
