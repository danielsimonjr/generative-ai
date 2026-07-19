/**
 * Supported file types for inbox ingestion.
 *
 * Text files are read directly and passed as prompt text. Media files are
 * handed to the ingest agent, which reads them with the built-in Read tool
 * (Claude Haiku is multimodal for images and PDFs).
 *
 * Note: unlike the Gemini original, audio and video are not supported —
 * Claude models do not process audio or video input.
 */
export const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".log",
  ".xml",
  ".yaml",
  ".yml",
]);

export const MEDIA_EXTENSIONS: Record<string, string> = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  // Documents
  ".pdf": "application/pdf",
};

export const ALL_SUPPORTED = new Set([...TEXT_EXTENSIONS, ...Object.keys(MEDIA_EXTENSIONS)]);

export const UNSUPPORTED_MEDIA = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".aac",
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".mkv",
  ".bmp",
  ".svg",
]);
