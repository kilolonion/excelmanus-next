import type { Capabilities } from "@excelmanus/protocol";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Compass,
  FileSpreadsheet,
  Loader2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/backend/api";
import { ensureActiveSession, useSessionStore } from "@/stores/session-store";

interface CompletionStepProps {
  /** 刚创建的模型档案；为空表示跳过了连接。 */
  profileId: string | null;
  finishing?: boolean;
  /** samplePath：已加入工作区的示例工作簿，完成后打开。 */
  onFinish: (samplePath?: string) => void;
  onOpenSettings: () => void;
  onBack: () => void;
}

const CAPABILITY_LABELS: [keyof Capabilities, string][] = [
  ["connectivity", "连接"],
  ["tools", "工具调用"],
  ["vision", "视觉"],
  ["reasoning", "思考"],
];

/** 连接成功后自动探测模型能力（09 §3），结果也会出现在设置 → 模型。 */
function CapabilityProbe({ profileId }: { profileId: string }) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api()
      .probeProfile(profileId)
      .then((res) => alive && setCaps(res.capabilities))
      .catch((e) => alive && setError(errorMessage(e, "能力探测失败")));
    return () => {
      alive = false;
    };
  }, [profileId]);
  if (error)
    return (
      <p className="em-onboarding-config-footnote" role="status">
        {error}，可稍后在设置中重新探测。
      </p>
    );
  return (
    <div className="em-onboarding-completion-topics" role="status" aria-live="polite">
      {CAPABILITY_LABELS.map(([key, label]) => {
        const value = caps?.[key].value;
        const Icon = !caps
          ? Loader2
          : value === true
            ? CheckCircle2
            : value === false
              ? XCircle
              : Circle;
        return (
          <span key={key}>
            <Icon aria-hidden="true" className={!caps ? "animate-spin" : undefined} /> {label}
            {caps && (value === true ? " ✓" : value === false ? " 不支持" : " 未知")}
          </span>
        );
      })}
    </div>
  );
}

export function CompletionStep({
  profileId,
  finishing,
  onFinish,
  onOpenSettings,
  onBack,
}: CompletionStepProps) {
  const configured = profileId !== null;
  const Icon = configured ? CheckCircle2 : Compass;
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  // 把内置示例工作簿复制进当前工作区，完成引导后直接打开。
  const startWithSample = async () => {
    setSampleBusy(true);
    setSampleError(null);
    try {
      const { items } = await api().listSamples();
      const name = items[0];
      if (!name) throw new Error("没有可用的示例工作簿");
      await ensureActiveSession();
      const workspaceId = useSessionStore.getState().activeWorkspaceId;
      if (!workspaceId) throw new Error("没有可用的工作区");
      const { path } = await api().addSample(workspaceId, name);
      onFinish(path);
    } catch (e) {
      setSampleError(errorMessage(e, "示例工作簿添加失败"));
    } finally {
      setSampleBusy(false);
    }
  };

  return (
    <div className="em-onboarding-step em-onboarding-completion">
      <span className="em-onboarding-completion-icon">
        <Icon aria-hidden="true" />
      </span>
      <div className="em-onboarding-eyebrow">{configured ? "设置完成" : "稍后连接模型"}</div>
      <h1 tabIndex={-1}>
        {configured ? "模型已就绪，开始第一个任务吧" : "先看看工作区，模型稍后连接"}
      </h1>
      <p>
        {configured
          ? "可以先用示例工作簿试一试：让代理读表、在表格上确认区域，再修改并查看变更高亮。"
          : "处理任务前需要至少一个模型档案，可以随时在「设置 → 模型」中添加。"}
      </p>
      {profileId && <CapabilityProbe profileId={profileId} />}
      {configured && (
        <Button
          onClick={() => void startWithSample()}
          disabled={finishing || sampleBusy}
          className="em-onboarding-primary-action"
        >
          {sampleBusy ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <FileSpreadsheet aria-hidden="true" />
          )}
          打开示例工作簿
        </Button>
      )}
      {sampleError && (
        <p className="em-onboarding-config-footnote" role="alert">
          {sampleError}
        </p>
      )}
      {configured ? (
        <button
          type="button"
          onClick={() => onFinish()}
          disabled={finishing}
          className="em-onboarding-secondary-action"
        >
          直接进入工作区 <ArrowRight aria-hidden="true" />
        </button>
      ) : (
        <Button
          onClick={() => onFinish()}
          disabled={finishing}
          className="em-onboarding-primary-action"
        >
          进入工作区 <ArrowRight aria-hidden="true" />
        </Button>
      )}
      {!configured && (
        <button type="button" onClick={onOpenSettings} className="em-onboarding-secondary-action">
          在设置中连接模型
        </button>
      )}
      {!configured && (
        <button type="button" onClick={onBack} className="em-onboarding-secondary-action">
          返回连接模型
        </button>
      )}
    </div>
  );
}
