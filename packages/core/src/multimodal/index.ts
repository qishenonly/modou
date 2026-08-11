/**
 * 多模态输入（T-133 图片输入）：能力探测（capabilities.images）+ 多模态消息
 * 构造（文件路径 / URI → AI SDK FilePart）+ 不支持时的诚实降级（notice）。
 * 0.17.x 扩展 attachFilesToUserMessage：任意文件附件（文本注入 / 图片 FilePart）。
 */
export {
  detectImageSupport,
  imageMimeFromPath,
  attachImagesToUserMessage,
  toImageFileParts,
  attachFilesToUserMessage,
} from './image';
export type {
  ImageInputOptions,
  ImageInputResult,
  ModelMessageUserPart,
  ModelMessageUserFilePart,
  FileInputOptions,
  FileInputResult,
} from './image';
