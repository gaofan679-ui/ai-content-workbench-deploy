import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

const allowedImageTypes = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
]);

export async function createTalkingHeadPersonAsset({ root, file, projectId = "" }) {
  if (!(file instanceof File) || file.size === 0)
    throw assetError("TALKING_PERSON_ASSET_MISSING", "请先选择一张人物母版图。");
  const extension = allowedImageTypes.get(file.type);
  if (!extension)
    throw assetError(
      "TALKING_PERSON_ASSET_TYPE_UNSUPPORTED",
      "人物母版只支持 PNG、JPG 或 WebP 图片。",
    );
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0)
    throw assetError("TALKING_PERSON_ASSET_EMPTY", "这张人物母版没有可读取的内容。");
  const assetId = randomUUID();
  const boundProjectId = projectId || randomUUID();
  if (!isUuid(boundProjectId))
    throw assetError(
      "TALKING_PERSON_PROJECT_ID_INVALID",
      "当前口播项目标识无效，请新建项目后重新选择图片。",
    );
  const assetDir = join(root, assetId);
  const path = join(assetDir, `original${extension}`);
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(path, buffer, { flag: "wx" });
  const asset = {
    schema_version: 1,
    asset_id: assetId,
    project_id: boundProjectId,
    asset_type: "talking_head_drive_master",
    route: "uploaded_master",
    source_kind: "user_upload",
    original_name: safeDisplayName(file.name),
    mime_type: file.type,
    size_bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    path,
    status: "stored_unconfirmed",
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(assetDir, "asset.json"), `${JSON.stringify(asset, null, 2)}\n`, {
    flag: "wx",
  });
  return asset;
}

export function createTalkingHeadPersonAssetBinding({ root, modelAsset, projectId }) {
  if (!modelAsset?.asset_id || !modelAsset?.path || !existsSync(modelAsset.path))
    throw assetError("TALKING_MODEL_ASSET_INVALID", "这张模特母版已经失效，请回到模特资产重新选择。");
  if (!isUuid(projectId))
    throw assetError(
      "TALKING_PERSON_PROJECT_ID_INVALID",
      "当前口播项目标识无效，请新建项目后重试。",
    );
  const buffer = readFileSync(modelAsset.path);
  const assetId = randomUUID();
  const assetDir = join(root, assetId);
  mkdirSync(assetDir, { recursive: true });
  const asset = {
    schema_version: 1,
    asset_id: assetId,
    project_id: projectId,
    asset_type: "talking_head_drive_master",
    route: "model_asset_library",
    source_kind: "model_asset",
    source_model_asset_id: modelAsset.asset_id,
    original_name: safeDisplayName(modelAsset.original_name || "已确认模特母版"),
    mime_type: modelAsset.mime_type || "image/png",
    size_bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    path: modelAsset.path,
    status: "bound_to_talking_project",
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(assetDir, "asset.json"), `${JSON.stringify(asset, null, 2)}\n`, {
    flag: "wx",
  });
  return asset;
}

export function getTalkingHeadPersonAsset(root, assetId) {
  if (!isUuid(assetId)) return null;
  const metadataPath = join(root, assetId, "asset.json");
  if (!existsSync(metadataPath)) return null;
  try {
    const asset = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (
      asset.asset_id !== assetId ||
      !["user_upload", "model_asset"].includes(asset.source_kind) ||
      !asset.path ||
      !existsSync(asset.path)
    )
      return null;
    const buffer = readFileSync(asset.path);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (buffer.length !== asset.size_bytes || sha256 !== asset.sha256) return null;
    return asset;
  } catch {
    return null;
  }
}

export function isTalkingHeadProjectId(value) {
  return isUuid(value);
}

export function publicTalkingHeadPersonAsset(asset) {
  if (!asset) return null;
  return {
    asset_id: asset.asset_id,
    project_id: asset.project_id,
    asset_type: asset.asset_type,
    route: asset.route,
    source_kind: asset.source_kind,
    original_name: asset.original_name,
    mime_type: asset.mime_type,
    size_bytes: asset.size_bytes,
    sha256: asset.sha256,
    status: asset.status,
    created_at: asset.created_at,
    source_model_asset_id: asset.source_model_asset_id || null,
  };
}

export function personAssetFile(asset) {
  return new File([readFileSync(asset.path)], asset.original_name || `人物母版${extname(asset.path)}`, {
    type: asset.mime_type,
  });
}

function safeDisplayName(value) {
  const normalized = [...String(value || "人物母版")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .trim()
    .slice(0, 120);
  return normalized || "人物母版";
}

function assetError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.external_request_started = false;
  return error;
}

function isUuid(value) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    String(value || ""),
  );
}
