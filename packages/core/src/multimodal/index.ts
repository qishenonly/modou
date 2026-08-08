/**
 * 多模态输入（T-133 图片输入）：能力探测（capabilities.images）+ 多模态消息
 * 构造（文件路径 / URI → AI SDK FilePart）+ 不支持时的诚实降级（notice）。
 */
export {
  detectImageSupport,
  imageMimeFromPath,
  attachImagesToUserMessage,
  toImageFileParts,
} from './image';
export type {
  ImageInputOptions,
  ImageInputResult,
  ModelMessageUserPart,
  ModelMessageUserFilePart,
} from './image';
