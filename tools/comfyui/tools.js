import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execAsync = promisify(exec);

const COMFYUI_URL = "http://127.0.0.1:8000";
const MINIO_SERVER = "michael@10.3.0.241";
const MINIO_ALIAS = "local";
const MINIO_BUCKET = "ai-it-mockups";
const MINIO_PUBLIC_URL = "http://10.3.0.241:9100";
const TEMP_DIR = join(__dirname, "..", "..", ".comfyui_temp");

// Ensure temp directory exists
if (!existsSync(TEMP_DIR)) {
  mkdirSync(TEMP_DIR, { recursive: true });
}

// Compute pixel dimensions from aspect ratio. 512 is the minimum dimension.
function aspectToDimensions(arW, arH) {
  const ratio = arW / arH;
  let width, height;
  if (ratio >= 1) {
    // Landscape or square — height is the short side
    height = 512;
    width = Math.round(512 * ratio / 8) * 8;
  } else {
    // Portrait — width is the short side
    width = 512;
    height = Math.round(512 / ratio / 8) * 8;
  }
  return { width, height };
}

// Parse Flux prompt from UX Designer output
function parseFluxPrompt(promptText) {
  const prompt = (promptText || "").replace(/\s*--ar\s+\d+:\d+\s*$/, "").trim();
  const arMatch = (promptText || "").match(/--ar\s+(\d+):(\d+)/);
  let width = 512, height = 512;

  if (arMatch) {
    ({ width, height } = aspectToDimensions(parseInt(arMatch[1]), parseInt(arMatch[2])));
  }

  return { prompt, width, height };
}

// Build ComfyUI workflow from prompt
function buildWorkflow(prompt, width, height) {
  const template = JSON.parse(readFileSync(join(__dirname, "..", "..", "flux_api.json"), "utf8"));
  
  // Update prompts
  template["6"].inputs.clip_l = prompt;
  template["6"].inputs.t5xxl = prompt;
  
  // Update dimensions on latent image node
  template["27"].inputs.width = width;
  template["27"].inputs.height = height;
  
  return template;
}

// Submit prompt to ComfyUI
async function submitToComfyUI(workflow) {
  const resp = await fetch(`${COMFYUI_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow })
  });
  
  if (!resp.ok) {
    throw new Error(`ComfyUI returned ${resp.status}: ${resp.statusText}`);
  }
  
  const data = await resp.json();
  return data.prompt_id;
}

// Poll for completion
async function waitForCompletion(promptId) {
  const maxAttempts = 300;
  const interval = 3000;
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetch(`${COMFYUI_URL}/history/${promptId}`);
      if (!resp.ok) continue;
      
      const data = await resp.json();
      const history = data[promptId];
      
      if (history?.outputs) {
        const output = history.outputs["9"]; // SaveImage node
        if (output?.images?.[0]) {
          return output.images[0];
        }
      }
    } catch (err) {
      console.error("[COMFYUI] Poll error:", err.message);
    }
    
    await new Promise(r => setTimeout(r, interval));
  }
  
  throw new Error(`Timeout waiting for prompt ${promptId}`);
}

// Download image from ComfyUI
async function downloadImage(filename) {
  const resp = await fetch(`${COMFYUI_URL}/view?filename=${encodeURIComponent(filename)}`);
  if (!resp.ok) {
    throw new Error(`Failed to download image ${filename}`);
  }
  
  const buffer = await resp.arrayBuffer();
  return Buffer.from(buffer);
}

// Upload to MinIO via SSH + mc command
async function uploadToMinIO(buffer, filename) {
  try {
    // Save buffer to local temp file
    const localTempPath = join(TEMP_DIR, filename);
    writeFileSync(localTempPath, buffer);
    console.error(`[COMFYUI] Saved temp file: ${localTempPath}`);
    
    // Create temp file on remote server and upload to MinIO
    const cmd = `ssh ${MINIO_SERVER} "cat > /tmp/comfyui_temp_${filename}" < "${localTempPath}" && \
                 ssh ${MINIO_SERVER} "mc cp /tmp/comfyui_temp_${filename} ${MINIO_ALIAS}/${MINIO_BUCKET}/${filename} && rm -f /tmp/comfyui_temp_${filename}"`;
    
    const { stderr } = await execAsync(cmd);
    if (stderr) console.error(`[COMFYUI] Upload stderr: ${stderr}`);
    
    // Clean up local temp file
    unlinkSync(localTempPath);
    console.error(`[COMFYUI] Cleaned up local temp file`);
    
    // Return the public URL
    const publicUrl = `${MINIO_PUBLIC_URL}/${MINIO_BUCKET}/${filename}`;
    console.error(`[COMFYUI] Uploaded to: ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    console.error("[COMFYUI] Upload error:", err.message);
    throw new Error(`Failed to upload to MinIO: ${err.message}`);
  }
}

// Main generation function - awaits full pipeline (submit, poll, download, upload)
async function generateMockup(promptText, aspectRatio = "9:16", screenName = "Unknown") {
  console.error(`[COMFYUI] Generating mockup: "${screenName}"`);

  // Parse prompt text (strips --ar from text) and get base dimensions
  let { prompt, width, height } = parseFluxPrompt(promptText);

  // If no --ar was in the prompt text, use the explicit aspectRatio parameter
  if (!(promptText || "").match(/--ar\s+\d+:\d+/) && aspectRatio) {
    const arParts = aspectRatio.match(/^(\d+):(\d+)$/);
    if (arParts) {
      ({ width, height } = aspectToDimensions(parseInt(arParts[1]), parseInt(arParts[2])));
    }
  }
  console.error(`[COMFYUI] Dimensions: ${width}x${height}`);

  // Create predictable filename for MinIO
  const safeName = screenName.replace(/[^a-zA-Z0-9]/g, "_");
  const resultFilename = `${safeName}_${Date.now()}.png`;

  // Build workflow
  const workflow = buildWorkflow(prompt, width, height);

  // Submit to ComfyUI
  const promptId = await submitToComfyUI(workflow);
  console.error(`[COMFYUI] Submitted with ID: ${promptId}`);

  // Wait for generation to complete
  const imageInfo = await waitForCompletion(promptId);
  console.error(`[COMFYUI] Generation complete: ${imageInfo.filename}`);

  // Download from ComfyUI
  const imageBuffer = await downloadImage(imageInfo.filename);
  console.error(`[COMFYUI] Downloaded ${imageBuffer.length} bytes`);

  // Upload to MinIO
  const publicUrl = await uploadToMinIO(imageBuffer, resultFilename);
  console.error(`[COMFYUI] Uploaded to MinIO: ${publicUrl}`);

  return {
    url: publicUrl,
    width,
    height,
    screenName,
    status: "completed"
  };
}

export { generateMockup, parseFluxPrompt, buildWorkflow, submitToComfyUI, waitForCompletion };

/**
 * Register ComfyUI tools on an McpServer instance.
 */
export function registerTools(server) {
  server.tool(
    "generate_image_mockup",
    "Generate a UI mockup image using ComfyUI (Flux.dev). Accepts a Flux prompt string and optional aspect ratio. Uploads to MinIO and returns a URL.",
    {
      prompt: z.string().describe("The Flux prompt text (e.g., 'A high-fidelity UI mockup of...'). Can include --ar aspect ratio."),
      aspect_ratio: z.string().optional().default("9:16").describe("Aspect ratio in format 'width:height' (e.g., '9:16', '16:9', '1:1'). Defaults to 9:16 for mobile screens."),
      screen_name: z.string().optional().default("UI Mockup").describe("Name of the screen for identification in logs and filenames.")
    },
    async ({ prompt, aspect_ratio, screen_name }) => {
      try {
        const result = await generateMockup(prompt, aspect_ratio, screen_name);
        return {
          content: [{
            type: "text",
            text: `Image generated.\n**Screen:** ${result.screenName}\n**Dimensions:** ${result.width}x${result.height}\n**URL:** ${result.url}\n\nMarkdown: ![${result.screenName}](${result.url})`
          }]
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Image generation failed: ${err.message}` }],
          isError: true
        };
      }
    }
  );
}
