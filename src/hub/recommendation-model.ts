/** Fixed-shape version advice; never a URL, shell command or remote update authority. */
import { z } from "zod";
import { epoch } from "./validation.js";
import { isExactVersion } from "../update-check.js";
export const HUB_RECOMMENDATION_CAPABILITY = "fleet-recommend-v1";
export const recommendedVersionSchema = z.string().min(1).max(128).refine(v => v === v.trim() && isExactVersion(v));
export const recommendationSchema = z.strictObject({ revision: epoch.min(1), setAt: epoch, version: recommendedVersionSchema.nullable() });
export const recommendationAckSchema = z.strictObject({ revision: epoch.min(1), version: recommendedVersionSchema.nullable(), status: z.enum(["offered", "current", "cleared"]) });
export interface HubRecommendation { revision: number; setAt: number; version: string | null }
export interface HubRecommendationAck { revision: number; version: string | null; status: "offered" | "current" | "cleared" }
export interface HubRecommendedUpdate { hubId: string; hubName: string; version: string; revision: number; setAt: number; receivedAt: number }
