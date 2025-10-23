#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { request } from "undici";
import sharp from "sharp";

// Environment configuration
const PROVIDER = process.env.GEMINI_PROVIDER || "ais";
const MODEL = process.env.GEMINI_MODEL || "models/gemini-flash-lite-latest";
const API_KEY = process.env.GEMINI_API_KEY;
const MAX_LONG_EDGE = process.env.VISION_MAX_LONG_EDGE
  ? parseInt(process.env.VISION_MAX_LONG_EDGE, 10)
  : 2048;

// Security and size limits
const MAX_IMAGES = 10;
const MAX_IMAGE_SIZE_MB = 18; // Leave headroom under 20MB AI Studio limit
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60000;

// Types
interface GeminiPart {
  inlineData?: {
    mimeType: string;
    data: string;
  };
  text?: string;
}

// Helper functions for image detection
function isURL(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function isFileURL(s: string): boolean {
  return /^file:\/\//i.test(s);
}

function isDataURI(s: string): boolean {
  return /^data:image\/[^;]+;base64,/.test(s);
}

function isAbsPath(s: string): boolean {
  return s.startsWith("/") || /^[A-Za-z]:\\/.test(s);
}

// Map sharp format to MIME type
function formatToMime(format: string): string {
  const map: Record<string, string> = {
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    tiff: "image/tiff",
    avif: "image/avif",
    heif: "image/heif",
    heic: "image/heic",
  };
  return map[format.toLowerCase()] || "image/png";
}

// Normalize model name for provider
function normalizeModelName(model: string, provider: string): string {
  if (provider === "vertex") {
    // Vertex doesn't want "models/" prefix in URL path
    return model.replace(/^models\//, "");
  }
  // AI Studio needs "models/" prefix
  return model.startsWith("models/") ? model : `models/${model}`;
}

// Convert image to Gemini part format
async function toPart(img: string): Promise<GeminiPart> {
  // Handle data URIs
  if (isDataURI(img)) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(img);
    if (!match) throw new Error("Invalid data URI format");

    // Validate it's an image MIME type
    if (!match[1].startsWith("image/")) {
      throw new Error(`Data URI must be an image, got: ${match[1]}`);
    }

    // Check size (base64 is ~4/3 of original)
    const estimatedSize = (match[2].length * 3) / 4;
    if (estimatedSize > MAX_IMAGE_SIZE_BYTES) {
      throw new Error(
        `Data URI too large: ~${Math.round(estimatedSize / 1024 / 1024)}MB (max ${MAX_IMAGE_SIZE_MB}MB)`
      );
    }

    return {
      inlineData: {
        mimeType: match[1],
        data: match[2],
      },
    };
  }

  // Handle HTTP URLs - fetch and inline (don't trust fileData.fileUri for external URLs)
  if (isURL(img)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const { body, statusCode, headers } = await request(img, {
        signal: controller.signal,
      });

      if (statusCode !== 200) {
        throw new Error(`Failed to fetch image: HTTP ${statusCode}`);
      }

      // Check content-type
      const contentType = headers["content-type"] as string || "";
      if (!contentType.startsWith("image/")) {
        throw new Error(`URL must return an image, got: ${contentType}`);
      }

      const buffer = Buffer.from(await body.arrayBuffer());

      if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
        throw new Error(
          `Image too large: ${Math.round(buffer.length / 1024 / 1024)}MB (max ${MAX_IMAGE_SIZE_MB}MB)`
        );
      }

      return await processImageBuffer(buffer);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Handle file:// URLs and absolute paths
  let filepath = img;
  if (isFileURL(img)) {
    filepath = fileURLToPath(img);
  }

  if (isAbsPath(filepath)) {
    const buffer = await readFile(filepath);
    return await processImageBuffer(buffer);
  }

  throw new Error(`Unsupported image format: ${img}`);
}

// Process image buffer: validate, resize if needed, return Gemini part
async function processImageBuffer(buffer: Buffer): Promise<GeminiPart> {
  // ALWAYS validate it's a real image using sharp
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (error) {
    throw new Error(`Not a valid image file: ${error}`);
  }

  if (!metadata.format || !metadata.width || !metadata.height) {
    throw new Error("Invalid or corrupted image");
  }

  const mimeType = formatToMime(metadata.format);
  let processedBuffer = buffer;

  // Resize if needed
  if (MAX_LONG_EDGE && MAX_LONG_EDGE > 0) {
    const maxDim = Math.max(metadata.width, metadata.height);
    if (maxDim > MAX_LONG_EDGE) {
      processedBuffer = await sharp(buffer)
        .resize(MAX_LONG_EDGE, MAX_LONG_EDGE, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .toBuffer();
    }
  }

  // Final size check
  if (processedBuffer.length > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(
      `Image too large after processing: ${Math.round(processedBuffer.length / 1024 / 1024)}MB (max ${MAX_IMAGE_SIZE_MB}MB)`
    );
  }

  return {
    inlineData: {
      mimeType,
      data: processedBuffer.toString("base64"),
    },
  };
}

// Call Gemini API with better error handling
async function callGemini(parts: GeminiPart[]): Promise<string> {
  if (PROVIDER === "vertex") {
    return callGeminiVertex(parts);
  } else {
    return callGeminiAIStudio(parts);
  }
}

// AI Studio implementation
async function callGeminiAIStudio(parts: GeminiPart[]): Promise<string> {
  if (!API_KEY) {
    throw new Error("GEMINI_API_KEY is required for AI Studio provider");
  }

  const modelName = normalizeModelName(MODEL, "ais");
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${API_KEY}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const { body, statusCode } = await request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts,
          },
        ],
      }),
      signal: controller.signal,
    });

    let json: any;
    try {
      json = await body.json();
    } catch (parseError) {
      const text = await body.text();
      throw new Error(
        `Failed to parse Gemini response (${statusCode}): ${text.substring(0, 200)}`
      );
    }

    if (statusCode !== 200) {
      throw new Error(
        `Gemini API error (${statusCode}): ${json.error?.message || JSON.stringify(json).substring(0, 200)}`
      );
    }

    const text =
      json.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text)
        .join("") ?? "";

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// Vertex AI implementation
async function callGeminiVertex(parts: GeminiPart[]): Promise<string> {
  const location = process.env.GEMINI_LOCATION || "us-central1";
  const project = process.env.GOOGLE_CLOUD_PROJECT;

  if (!project) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT is required for Vertex AI provider"
    );
  }

  const accessToken = await getVertexAccessToken();
  const modelName = normalizeModelName(MODEL, "vertex");
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${modelName}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const { body, statusCode } = await request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts,
          },
        ],
      }),
      signal: controller.signal,
    });

    let json: any;
    try {
      json = await body.json();
    } catch (parseError) {
      const text = await body.text();
      throw new Error(
        `Failed to parse Vertex response (${statusCode}): ${text.substring(0, 200)}`
      );
    }

    if (statusCode !== 200) {
      throw new Error(
        `Gemini Vertex API error (${statusCode}): ${json.error?.message || JSON.stringify(json).substring(0, 200)}`
      );
    }

    const text =
      json.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text)
        .join("") ?? "";

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// Get Vertex AI access token (prefers ADC; optional google-auth-library; falls back to gcloud)
async function getVertexAccessToken(): Promise<string> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  // If an explicit access token is provided, use it.
  const explicit = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }

  // Try google-auth-library (ADC) if available (no gcloud required)
  try {
    // Use computed specifier so TypeScript doesn't require the module at build time
    const mod: any = await import("google-auth-" + "library");
    const GoogleAuth = mod.GoogleAuth;
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    if (token && typeof token === "string" && token.trim().length > 0) {
      return token.trim();
    }
  } catch {
    // library not installed or ADC not configured; continue
  }

  // Helper to try a command and return trimmed stdout
  const tryCmd = async (cmd: string) => {
    const { stdout } = await execAsync(cmd);
    const token = stdout.trim();
    if (!token) throw new Error(`No output from: ${cmd}`);
    return token;
  };

  // Prefer Application Default Credentials if available
  // Works with GOOGLE_APPLICATION_CREDENTIALS or `gcloud auth application-default login`
  try {
    return await tryCmd("gcloud auth application-default print-access-token");
  } catch {}

  // Fallback: use user credentials from `gcloud auth login`
  try {
    return await tryCmd("gcloud auth print-access-token");
  } catch (error) {
    throw new Error(
      `Failed to get Vertex AI access token. Configure ADC via GOOGLE_APPLICATION_CREDENTIALS or 'gcloud auth application-default login', or run 'gcloud auth login'. Error: ${error}`
    );
  }
}

// Initialize MCP server
const server = new Server(
  {
    name: "mcp-vision",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "vision.analyze",
        description:
          "Send images + an instruction to Gemini Flash-Lite; returns raw text. " +
          "Accepts images as URLs (https://...), file URLs (file://...), absolute paths (/path/to/img), or data URIs (data:image/...;base64,...). " +
          "HTTP(S) URLs are fetched and validated. All images are validated as real images and auto-resized if needed (default max 2048px). " +
          "Pass a natural language instruction and get back the model's text response. " +
          "For structured output, request JSON format in your instruction (e.g., 'Return JSON with {overlap: boolean, examples: [...]}'). " +
          "Examples: 'Do any borders overlap text?', 'Rate whitespace 0-1 and suggest one fix', 'Extract all button labels as JSON array'.",
        inputSchema: {
          type: "object",
          properties: {
            images: {
              oneOf: [
                { type: "string" },
                {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: MAX_IMAGES,
                },
              ],
              description:
                "One or more images as URLs, file paths, file:// URLs, or data URIs",
            },
            instruction: {
              type: "string",
              minLength: 1,
              description:
                "Natural language task for the screenshot(s). Request JSON format if you need structured output.",
            },
          },
          required: ["images", "instruction"],
          additionalProperties: false,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "vision.analyze") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { images, instruction } = request.params.arguments as {
    images: string | string[];
    instruction: string;
  };

  if (!images) {
    throw new Error("Missing required parameter: images");
  }

  if (!instruction || instruction.trim().length === 0) {
    throw new Error("Missing required parameter: instruction");
  }

  // Normalize images to array
  const imageArray = Array.isArray(images) ? images : [images];

  if (imageArray.length === 0) {
    throw new Error("At least one image is required");
  }

  if (imageArray.length > MAX_IMAGES) {
    throw new Error(`Too many images: ${imageArray.length} (max ${MAX_IMAGES})`);
  }

  // Convert all images to Gemini parts
  const parts: GeminiPart[] = [];
  for (const img of imageArray) {
    parts.push(await toPart(img));
  }

  // Add the instruction as the final text part
  parts.push({ text: instruction });

  // Call Gemini
  const text = await callGemini(parts);

  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Vision server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
