import { z } from "zod";

export const packageName = "@excelmanus/protocol";

export const packageNameSchema = z.literal(packageName);
