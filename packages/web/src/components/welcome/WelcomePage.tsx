import { motion } from "framer-motion";
import {
  Code2,
  Loader2,
  type LucideIcon,
  Paperclip,
  ScanLine,
  TableProperties,
  TrendingUp,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { isImageFile, isSpreadsheetFile } from "@/lib/file-kind";
import { duration } from "@/lib/sidebar-motion";
import { addComposerFiles, attachWorkspaceFile, useChatStore } from "@/stores/chat-store";
import { uploadFiles } from "@/stores/files-store";
import { openWorkbook } from "@/stores/workbook-store";
import styles from "./WelcomePage.module.css";
import { WorkbookStart } from "./WorkbookStart";

const smoothEase: [number, number, number, number] = [0.4, 0, 0.2, 1];

interface SampleFileRef {
  path: string;
  name: string;
}

interface Suggestion {
  id: string;
  label: string;
  summary: string;
  text: string;
  icon: LucideIcon;
  samples?: SampleFileRef[];
}

const SUGGESTIONS: Suggestion[] = [
  {
    id: "sales-dashboard",
    label: "经营分析",
    summary: "按区域汇总销售、计算同比，生成趋势图与经营结论。",
    text: "把月度销售数据做成经营看板：按区域汇总、计算同比、生成趋势图，并写出关键结论",
    icon: TrendingUp,
    samples: [{ path: "/samples/月度销售报表.csv", name: "月度销售报表.csv" }],
  },
  {
    id: "cross-workbook-match",
    label: "跨表自动化",
    summary: "匹配产品信息、补齐订单金额，保留公式并标记异常。",
    text: "补齐订单工作表：从产品目录匹配产品名称和单价，计算金额，保留公式并标记未匹配项",
    icon: TableProperties,
    samples: [{ path: "/samples/订单与产品.xlsx", name: "订单与产品.xlsx" }],
  },
  {
    id: "receipt-visual-replica",
    label: "图片转 Excel",
    summary: "提取收据明细、核对合计，还原为可编辑的 Excel。",
    text: "把这张收款收据还原成可编辑 Excel：提取客户、明细、数量和金额，核对合计并保留原有布局",
    icon: ScanLine,
    samples: [{ path: "/samples/收款收据.jpg", name: "收款收据.jpg" }],
  },
  {
    id: "statistical-regression",
    label: "高级分析",
    summary: "分析广告与销售的关系，生成回归图表和预测公式。",
    text: "评估广告投入是否带来销售增长：做回归分析，生成散点图和预测公式，把结果写回 Excel",
    icon: Code2,
    samples: [{ path: "/samples/广告与销售数据.csv", name: "广告与销售数据.csv" }],
  },
];

interface WelcomePageProps {
  /** 示例文件已由本页放进工作区 / 输入框附件，这里只带提示词。 */
  onSuggestionClick: (text: string) => void;
}

const containerVariants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
};

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: duration.normal, ease: smoothEase } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: duration.normal, ease: smoothEase } },
};

function mimeForName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".csv":
      return "text/csv";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/**
 * 示例文件进入当前工作区：图片作为消息附件，其余上传后以 @路径 引用；
 * 还没有会话时（新对话）先上传到工作区，再作为工作区文件引用。返回工作区里的路径。
 */
async function addSampleFiles(files: File[]): Promise<string[]> {
  if (useChatStore.getState().workspaceId) return addComposerFiles(files);
  const paths = await uploadFiles(files);
  for (const path of paths) attachWorkspaceFile(path);
  return paths;
}

async function fetchSampleFile(ref: SampleFileRef): Promise<File | null> {
  try {
    const res = await fetch(ref.path);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], ref.name, { type: blob.type || mimeForName(ref.name) });
  } catch {
    return null;
  }
}

export function WelcomePage({ onSuggestionClick }: WelcomePageProps) {
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const prefetchCache = useRef<Map<string, Promise<File | null>>>(new Map());
  const clickLockRef = useRef(false);

  const ensureSample = useCallback((ref: SampleFileRef) => {
    const existing = prefetchCache.current.get(ref.path);
    if (existing) return existing;
    const task = fetchSampleFile(ref);
    prefetchCache.current.set(ref.path, task);
    return task;
  }, []);

  const prefetchSample = useCallback(
    (suggestion: Suggestion) => {
      if (!suggestion.samples?.length) return;
      for (const s of suggestion.samples) void ensureSample(s);
    },
    [ensureSample],
  );

  const handleClick = useCallback(
    async (suggestion: Suggestion) => {
      if (clickLockRef.current) return;
      clickLockRef.current = true;
      setLoadingKey(suggestion.text);
      setErrorKey(null);

      try {
        if (!suggestion.samples?.length) {
          onSuggestionClick(suggestion.text);
          return;
        }

        let files = (await Promise.all(suggestion.samples.map((s) => ensureSample(s)))).filter(
          (f): f is File => f !== null,
        );

        if (files.length !== suggestion.samples.length) {
          for (const s of suggestion.samples) prefetchCache.current.delete(s.path);
          files = (await Promise.all(suggestion.samples.map((s) => ensureSample(s)))).filter(
            (f): f is File => f !== null,
          );
        }

        if (files.length !== suggestion.samples.length) {
          setErrorKey(suggestion.text);
          return;
        }

        try {
          const paths = await addSampleFiles(files);
          // 表格示例直接在侧边面板打开，边看边聊
          const sheet = paths.find((p) => isSpreadsheetFile(p));
          if (sheet) void openWorkbook(sheet).catch(() => undefined);
        } catch {
          setErrorKey(suggestion.text);
          return;
        }
        onSuggestionClick(suggestion.text);
      } finally {
        setLoadingKey(null);
        clickLockRef.current = false;
      }
    },
    [onSuggestionClick, ensureSample],
  );

  return (
    <div className={styles.viewport}>
      <motion.div
        className={styles.layout}
        variants={containerVariants}
        initial="hidden"
        animate="show"
      >
        <motion.section className={styles.hero} variants={fadeUp} aria-labelledby="welcome-title">
          <div className={styles.heroContent}>
            <div className={styles.kicker}>表格智能助手</div>
            <h1 id="welcome-title" className={styles.title}>
              从一张表开始。
            </h1>
            <p className={styles.description}>打开已有 Excel，边看表，边提问，也可以直接编辑。</p>
            <WorkbookStart />
          </div>
        </motion.section>

        <div className={styles.heading}>
          <h2 id="welcome-tasks-title">从一个具体任务开始</h2>
          <p>选择示例，或在下方输入你的目标</p>
        </div>

        <motion.div
          className={styles.tasks}
          role="group"
          aria-labelledby="welcome-tasks-title"
          variants={{
            hidden: {},
            show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
          }}
        >
          {SUGGESTIONS.map((suggestion) => {
            const { label, summary, text, icon: Icon, samples } = suggestion;
            const isThis = loadingKey === text;
            const isBusy = !!loadingKey;
            const hasError = errorKey === text;
            return (
              <motion.button
                key={text}
                type="button"
                variants={cardVariants}
                whileTap={isBusy ? {} : { scale: 0.99 }}
                onPointerEnter={() => prefetchSample(suggestion)}
                onPointerDown={() => prefetchSample(suggestion)}
                onFocus={() => prefetchSample(suggestion)}
                onClick={() => handleClick(suggestion)}
                disabled={isBusy}
                aria-label={`试用示例：${label}。 ${text}${hasError ? "。示例文件加载失败，请再试一次" : ""}`}
                aria-busy={isThis}
                title={hasError ? "示例文件加载失败，请再试一次" : text}
                data-loading={isThis || undefined}
                data-error={hasError || undefined}
                className={styles.card}
              >
                <span className={styles.cardContent}>
                  <span className={styles.cardHeader}>
                    <span className={styles.icon} aria-hidden="true">
                      {isThis ? <Loader2 className={styles.spinner} /> : <Icon />}
                    </span>
                    <span className={styles.label}>{label}</span>
                  </span>
                  <span className={styles.copy}>{summary}</span>
                  <span className={styles.footer}>
                    {hasError ? (
                      <span className={styles.error} role="status">
                        加载失败，点击重试
                      </span>
                    ) : (
                      samples?.map((sample) => (
                        <span key={sample.name} className={styles.file}>
                          {isImageFile(sample.name) ? (
                            <img src={sample.path} alt="" width={32} height={24} />
                          ) : (
                            <Paperclip aria-hidden="true" />
                          )}
                          <span className={styles.filename}>{sample.name}</span>
                        </span>
                      ))
                    )}
                  </span>
                </span>
              </motion.button>
            );
          })}
        </motion.div>
      </motion.div>
    </div>
  );
}
