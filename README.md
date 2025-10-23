# mcp-vision

Dead-simple MCP server for vision analysis with Google Gemini Flash-Lite.

## What it does

Exposes a single MCP tool that sends your images + a single instruction string straight to Google Gemini Flash-Lite and returns the model's raw text answer.

- **One tool, one job**: `vision.analyze`
- **Backend**: Google AI Studio or Vertex AI (your choice)
- **Default model**: `models/gemini-flash-lite-latest`
- **Modes**: Text + images (no audio/video in v1)

## Installation

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and configure:

### Option 1: AI Studio (Recommended for simplicity)

```bash
GEMINI_PROVIDER=ais
GEMINI_API_KEY=your_api_key_here
```

Get your API key at: https://aistudio.google.com/app/apikey

### Option 2: Vertex AI

```bash
GEMINI_PROVIDER=vertex
GOOGLE_CLOUD_PROJECT=your-project-id
GEMINI_LOCATION=us-central1
```

Auth options (any one works):
- Application Default Credentials (recommended): set `G​OOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` or run `gcloud auth application-default login`
- User credentials: run `gcloud auth login`

Token resolution order used by the server:
1) If installed, use `google-auth-library` to acquire an ADC token (no gcloud required)
2) `gcloud auth application-default print-access-token`
3) `gcloud auth print-access-token`

### Optional Settings

```bash
# Use a different model
GEMINI_MODEL=models/gemini-flash-lite-latest

# Auto-resize images - DEFAULT is 2048px (set to 0 to disable)
VISION_MAX_LONG_EDGE=2048
```

## Claude Desktop Setup

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vision": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-vision/dist/index.js"],
      "env": {
        "GEMINI_PROVIDER": "ais",
        "GEMINI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Or using npx:

```json
{
  "mcpServers": {
    "vision": {
      "command": "npx",
      "args": ["-y", "mcp-gemini-vision"],
      "env": {
        "GEMINI_PROVIDER": "ais",
        "GEMINI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## Usage

The tool accepts:

**Input:**
```typescript
{
  "images": "https://example.com/screenshot.png" | ["/path/to/img1.png", "data:image/png;base64,..."],
  "instruction": "Natural language task for the screenshot(s)."
}
```

**Output:**
```typescript
{
  "text": "<Gemini raw text reply>"
}
```

### Image formats supported

- HTTP(S) URLs: `https://example.com/image.png`
- File URLs: `file:///absolute/path/to/image.png`
- Absolute paths: `/absolute/path/to/image.png`
- Data URIs: `data:image/png;base64,iVBORw0KG...`

### Example instructions

**Overlap check:**
```
"Return JSON {overlap:boolean, examples:[{text,bbox,reason}]} — do any borders overlap any text?"
```

**Aesthetic analysis:**
```
"In one sentence: does the hero feel cramped? If so, suggest one fix."
```

**OCR:**
```
"What does the toast say? Quote exactly."
```

**Extract UI elements:**
```
"Extract all visible button labels as a JSON array."
```

**Whitespace rating:**
```
"Rate hero whitespace 0–1; if <0.6, give exactly one fix."
```

## How it works

1. **Normalize images**: Accept URLs, file paths, file:// URLs, or data URIs
   - HTTP(S) URLs are fetched with timeout and validated
   - All images are validated as real images using `sharp` (prevents exfiltration)
   - MIME types derived from actual image format, not file extension
2. **Auto-resize**: Images larger than 2048px (configurable) are automatically downscaled
3. **Call Gemini once**: Build parts array with images + instruction text, with 60s timeout
4. **Return raw**: Return exactly what Gemini sends back (no schema coercion)
5. **Error handling**: Try/catch on JSON parsing with fallback to text for better diagnostics

## Security & Limits

- **Image validation**: All images validated with `sharp.metadata()` before upload (prevents arbitrary file exfiltration)
- **Size limits**: Max 18MB per image, max 10 images per request
- **Timeouts**: 60s for HTTP fetches and API calls
- **Auto-resize**: ON by default at 2048px (set `VISION_MAX_LONG_EDGE=0` to disable, but validation still runs)
- **Images + text only** (no audio/video in v1)

For larger or frequently reused assets, consider the Gemini Files API (future enhancement).

## Development

```bash
npm run dev    # Watch mode
npm run build  # Compile TypeScript
npm start      # Run compiled server
```

## License

MIT
