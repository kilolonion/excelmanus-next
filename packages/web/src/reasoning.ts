import { ReasoningLevel } from "@excelmanus/protocol";
import { ST } from "./strings.ts";

export const reasoningOptions = ReasoningLevel.options
  .filter((level) => level !== "minimal")
  .map((value) => ({ value, label: ST.thinkingLabel[value] }));
