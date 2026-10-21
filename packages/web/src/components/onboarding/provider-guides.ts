// 首次使用向导的供应商列表：供应商身份、默认地址与建议模型来自后端预设（GET /providers），
// 这里只维护引导文案。

import type { ProviderPreset } from "@excelmanus/protocol";

export interface GuideStep {
  title: string;
  description: string;
}

export interface ProviderGuide {
  id: string;
  label: string;
  description: string;
  pricing: string;
  recommended?: boolean;
  /** 获取 API Key / 开通服务的页面。 */
  purchaseUrl?: string;
  /** 默认模型 ID（预设的第一个建议模型）。 */
  model: string;
  suggestedModels: string[];
  baseUrl: string;
  /** 需要用户填写 Base URL（自定义兼容接口）。 */
  requiresBaseUrl: boolean;
  auth: "api_key" | "subscription" | "none";
  note?: string;
  steps: GuideStep[];
}

type GuideCopy = Pick<ProviderGuide, "description" | "pricing" | "recommended" | "steps">;

const GUIDE_COPY: Record<string, Partial<GuideCopy>> = {
  openai: {
    description: "GPT 系列 — 通用能力强、生态完善",
    pricing: "按官方实时价格计费（请以 OpenAI 控制台为准）",
    recommended: true,
    steps: [
      {
        title: "1. 注册 OpenAI 账号",
        description:
          "打开 platform.openai.com，点击「Sign Up」注册。需要邮箱验证，部分地区可能需要手机号验证。",
      },
      {
        title: "2. 充值余额",
        description: "进入 Settings → Billing，添加支付方式并充值。OpenAI API 为预付费模式。",
      },
      {
        title: "3. 创建 API Key",
        description:
          "进入 API Keys 页面，点击「Create new secret key」，复制生成的 Key 并粘贴到下方。注意：Key 只显示一次，请妥善保存。",
      },
    ],
  },
  anthropic: {
    description: "Claude 系列 — 代码与推理能力一流",
    pricing: "按官方实时价格计费（请以 Anthropic 控制台为准）",
    recommended: true,
    steps: [
      {
        title: "1. 注册 Anthropic 账号",
        description: "打开 console.anthropic.com，使用邮箱注册并完成验证。",
      },
      {
        title: "2. 充值余额",
        description: "进入 Settings → Billing，添加信用卡并充值。最低 $5 起充。",
      },
      {
        title: "3. 创建 API Key",
        description: "进入 Settings → API Keys，点击「Create Key」，复制 Key 并粘贴到下方。",
      },
    ],
  },
  google: {
    description: "Gemini 系列 — 速度快、性价比高",
    pricing: "按官方实时价格计费（请以控制台为准）",
    steps: [
      {
        title: "1. 访问 Google AI Studio",
        description:
          "打开 aistudio.google.com/apikey，用 Google 账号登录后创建 API Key。Gemini 提供免费额度，无需预充值。",
      },
      {
        title: "2. 创建 API Key",
        description:
          "点击页面中的「Create API Key」按钮，选择一个 Google Cloud 项目（或创建新项目），即可生成 API Key。",
      },
      {
        title: "3. 复制 Key 并粘贴",
        description: "点击复制按钮将 API Key 复制到剪贴板，然后回到本页面粘贴到下方输入框中。",
      },
    ],
  },
  deepseek: {
    description: "DeepSeek-V3 — 中文理解出色，性价比极高",
    pricing: "按官方实时价格计费（新用户通常有试用额度）",
    recommended: true,
    steps: [
      {
        title: "1. 注册 DeepSeek 账号",
        description:
          "打开 platform.deepseek.com，使用手机号或邮箱注册。新用户注册可获赠免费 token 额度。",
      },
      {
        title: "2. 创建 API Key",
        description: "登录后进入「API Keys」页面，点击「创建 API Key」，为 Key 取一个名称后确认。",
      },
      {
        title: "3. 复制并充值（可选）",
        description: "复制生成的 API Key 并粘贴到下方。免费额度用完后可在「充值」页面充值。",
      },
    ],
  },
  qwen: {
    description: "通义千问 Qwen-Plus — 国内直连",
    pricing: "按官方实时价格计费（新用户通常有试用额度）",
    recommended: true,
    steps: [
      {
        title: "1. 注册阿里云账号",
        description: "使用手机号注册阿里云账号（或用已有账号登录），首次使用需开通「百炼」服务。",
      },
      {
        title: "2. 获取 API Key",
        description: "进入百炼控制台 → API Key 管理页面，点击「创建 API Key」即可生成。",
      },
      {
        title: "3. 复制并使用",
        description: "复制 API Key 粘贴到下方。阿里云百炼在国内直连，延迟低且稳定。",
      },
    ],
  },
  zhipu: {
    description: "GLM-4.5 — 国产大模型，国内直连",
    pricing: "按官方实时价格计费（新用户通常有试用额度）",
    steps: [
      {
        title: "1. 注册智谱 AI 账号",
        description: "打开 open.bigmodel.cn，使用手机号注册并完成实名认证。",
      },
      {
        title: "2. 获取 API Key",
        description: "进入用户中心 → API Keys 页面，点击「新建 API Key」即可生成。",
      },
      {
        title: "3. 复制并使用",
        description: "复制 Key 粘贴到下方。智谱 AI 国内直连，新注册用户有免费 token 额度。",
      },
    ],
  },
  openrouter: {
    description: "全球模型聚合路由 — 一个 Key 用遍全球",
    pricing: "按模型计费，支持多种支付方式",
    steps: [
      {
        title: "1. 注册 OpenRouter 账号",
        description: "打开 openrouter.ai，使用 Google 或 GitHub 账号快速注册。",
      },
      {
        title: "2. 充值并获取 Key",
        description: "进入 Keys 页面创建新的 API Key，并在 Credits 页面充值。",
      },
      {
        title: "3. 复制并使用",
        description: "复制 Key 粘贴到下方。OpenRouter 支持多家模型的统一接口调用。",
      },
    ],
  },
  moonshot: {
    description: "Kimi K2 — 长上下文、中文理解出色",
    pricing: "按官方实时价格计费（新用户通常有试用额度）",
    steps: [
      {
        title: "1. 注册 Moonshot 账号",
        description: "打开 platform.moonshot.cn，使用手机号注册并完成验证。",
      },
      {
        title: "2. 创建 API Key",
        description: "进入控制台 → API Key 管理页面，点击「新建 API Key」即可生成。",
      },
      {
        title: "3. 复制并使用",
        description: "复制 Key 粘贴到下方。Kimi 国内直连，新注册用户有免费 token 额度。",
      },
    ],
  },
  minimax: {
    description: "MiniMax M2 — 通用推理能力",
    pricing: "按官方实时价格计费（请以 MiniMax 控制台为准）",
    steps: [
      {
        title: "1. 注册 MiniMax 账号",
        description: "打开 platform.minimax.io，注册并完成账号验证。",
      },
      { title: "2. 创建 API Key", description: "进入控制台的 API Keys 页面创建密钥。" },
      { title: "3. 复制并使用", description: "将 API Key 粘贴到下方，默认 Base URL 已预填。" },
    ],
  },
  xai: {
    description: "Grok 4 — 强推理与实时信息能力",
    pricing: "按官方实时价格计费（请以 xAI 控制台为准）",
    steps: [
      { title: "1. 注册 xAI 账号", description: "打开 console.x.ai，使用 X 账号登录并完成验证。" },
      { title: "2. 创建 API Key", description: "进入 API Keys 页面创建密钥并配置项目额度。" },
      { title: "3. 复制并使用", description: "将 API Key 粘贴到下方。" },
    ],
  },
  doubao: {
    description: "豆包 — 国内直连，中文任务表现稳定",
    pricing: "按官方实时价格计费（新用户通常有试用额度）",
    steps: [
      {
        title: "1. 注册火山引擎账号",
        description: "打开火山引擎控制台，完成实名认证并进入方舟服务。",
      },
      {
        title: "2. 创建 API Key",
        description: "在方舟控制台创建 API Key，并开通对应模型的调用权限。",
      },
      {
        title: "3. 复制并使用",
        description: "将 API Key 粘贴到下方；模型部署 ID 也可以在方舟控制台中替换为实际 endpoint。",
      },
    ],
  },
  mimo: {
    description: "小米 MiMo — 全模态理解，国内直连",
    pricing: "按官方实时价格计费（新用户通常有试用额度）",
    steps: [
      {
        title: "1. 注册小米 MiMo 开放平台账号",
        description: "打开 platform.xiaomimimo.com，使用小米账号或手机号注册登录。",
      },
      {
        title: "2. 创建 API Key",
        description: "进入控制台 → API Keys 页面，创建新的 API Key（sk- 开头）。",
      },
      {
        title: "3. 复制并使用",
        description: "复制 Key 粘贴到下方。MiMo API 国内直连，兼容 OpenAI / Anthropic 协议。",
      },
    ],
  },
  chatgpt: {
    description: "ChatGPT Plus/Pro 订阅模型（支持 Codex 登录）",
    pricing: "使用 ChatGPT Plus/Pro 订阅，无需单独 API 充值",
    steps: [
      {
        title: "1. 登录 ChatGPT",
        description: "确保账号已开通 ChatGPT Plus/Pro 的 Codex 订阅能力。",
      },
      {
        title: "2. 完成 Codex 授权",
        description: "点击下方「前往授权」，在「设置 → 模型」中登录 ChatGPT 账号并完成浏览器授权。",
      },
      {
        title: "3. 保存模型",
        description: "连接成功后自动创建模型档案，即可在模型选择器中使用 Codex。",
      },
    ],
  },
};

const GENERIC_STEPS: GuideStep[] = [
  { title: "1. 开通服务", description: "在供应商控制台注册账号并开通模型调用权限。" },
  { title: "2. 获取 API Key", description: "在控制台的 API Key 页面创建密钥。" },
  {
    title: "3. 填入连接信息",
    description: "将 API Key、模型 ID（以及需要时的 Base URL）填入下方。",
  },
];

const LOCAL_STEPS: GuideStep[] = [
  { title: "1. 启动本机服务", description: "确认本机模型服务已启动，并已下载要使用的模型。" },
  { title: "2. 填写模型 ID", description: "填写本机服务中的模型名称；默认地址通常无需修改。" },
];

/** 由后端预设生成向导条目，保持后端返回的顺序；订阅类排在前面由界面分组。 */
export function buildProviderGuides(presets: readonly ProviderPreset[]): ProviderGuide[] {
  return presets.map((preset) => {
    const copy = GUIDE_COPY[preset.id] ?? {};
    const auth = preset.auth ?? "api_key";
    const suggestedModels = preset.suggestedModels ?? [];
    return {
      id: preset.id,
      label: preset.displayName,
      description:
        copy.description ?? preset.note ?? (preset.directChina ? "国内直连" : "OpenAI 兼容接口"),
      pricing:
        copy.pricing ?? (auth === "none" ? "本机运行，无需 API 费用" : "按供应商实时价格计费"),
      ...(copy.recommended ? { recommended: true } : {}),
      ...(preset.apiKeyHelpUrl ? { purchaseUrl: preset.apiKeyHelpUrl } : {}),
      model: suggestedModels[0] ?? "",
      suggestedModels,
      baseUrl: preset.defaultBaseUrl ?? "",
      requiresBaseUrl: preset.adapter === "openai-compatible" && !preset.defaultBaseUrl,
      auth,
      ...(preset.note ? { note: preset.note } : {}),
      steps: copy.steps ?? (auth === "none" ? LOCAL_STEPS : GENERIC_STEPS),
    };
  });
}
