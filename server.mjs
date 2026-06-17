import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4181);
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const maxBodyBytes = 14 * 1024 * 1024;

const types = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json;charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("图片太大，请压缩后再试"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  const parts = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function parseJsonText(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI 返回格式不是 JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeFields(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    itemNo: String(input.itemNo || "").trim().slice(0, 24),
    brand: String(input.brand || "").trim().slice(0, 42),
    productName: String(input.productName || "").trim().slice(0, 96),
    spec: String(input.spec || "").trim().slice(0, 64),
    originalPrice: String(input.originalPrice || "").trim().slice(0, 18),
    discount: String(input.discount || "").trim().slice(0, 18),
    finalPrice: String(input.finalPrice || "").trim().slice(0, 18),
    expiry: String(input.expiry || "").trim().slice(0, 24),
    savingsLabel: String(input.savingsLabel || "Instant Savings").trim().slice(0, 32),
    confidence: Math.max(0, Math.min(1, Number(input.confidence || 0)))
  };
}

function extractionPrompt() {
  return [
    "You read Costco Canada shelf price tags from images.",
    "Extract only text that is visible on the tag. Do not search or guess.",
    "The first image is the price tag. A second product image may be provided only to cross-check the brand/product type.",
    "Return JSON only with these fields:",
    "{",
    "  \"itemNo\": \"Costco item number\",",
    "  \"brand\": \"brand visible on tag\",",
    "  \"productName\": \"English product name visible on tag, excluding brand when brand is separate\",",
    "  \"spec\": \"size, count, color, gender, or other visible spec\",",
    "  \"originalPrice\": \"original price if visible\",",
    "  \"discount\": \"instant savings amount if visible, include minus sign if shown\",",
    "  \"finalPrice\": \"large final/sell price\",",
    "  \"expiry\": \"EXP date if visible\",",
    "  \"savingsLabel\": \"Instant Savings or visible savings label\",",
    "  \"confidence\": 0.0",
    "}",
    "For unreadable fields, use an empty string.",
    "Keep numbers exactly as visible."
  ].join("\n");
}

function reviewPrompt(fields) {
  return [
    "You are verifying OCR fields extracted from a Costco Canada price tag image.",
    "Look at the image again and compare it with this JSON:",
    JSON.stringify(fields),
    "Return JSON only:",
    "{",
    "  \"ok\": true,",
    "  \"issues\": [\"short issue text\"],",
    "  \"corrections\": { \"fieldName\": \"corrected value\" },",
    "  \"confidence\": {",
    "    \"itemNo\": 0.0, \"brand\": 0.0, \"productName\": 0.0, \"spec\": 0.0,",
    "    \"originalPrice\": 0.0, \"discount\": 0.0, \"finalPrice\": 0.0, \"expiry\": 0.0",
    "  }",
    "}",
    "Use corrections only when the image clearly contradicts the extracted field.",
    "If a field is unreadable, set its confidence below 0.7 and add an issue."
  ].join("\n");
}

async function callOpenAI(content, maxOutputTokens = 600) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content }],
      max_output_tokens: maxOutputTokens,
      store: false
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || "AI 识别失败");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function extractLabel(priceImage, productImage) {
  const content = [{ type: "input_text", text: extractionPrompt() }];
  content.push({ type: "input_image", image_url: priceImage, detail: "high" });
  if (productImage) content.push({ type: "input_image", image_url: productImage, detail: "low" });
  const response = await callOpenAI(content);
  return normalizeFields(parseJsonText(extractOutputText(response)));
}

async function reviewLabel(priceImage, fields) {
  const content = [
    { type: "input_text", text: reviewPrompt(fields) },
    { type: "input_image", image_url: priceImage, detail: "high" }
  ];
  const response = await callOpenAI(content, 500);
  const review = parseJsonText(extractOutputText(response));
  const corrections = review.corrections && typeof review.corrections === "object" ? review.corrections : {};
  return {
    ok: Boolean(review.ok),
    issues: Array.isArray(review.issues) ? review.issues.map(String).slice(0, 8) : [],
    corrections: normalizeFields({ ...fields, ...corrections }),
    confidence: review.confidence && typeof review.confidence === "object" ? review.confidence : {}
  };
}

async function handleExtract(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  if (!apiKey) return sendJson(res, 500, { error: "Railway 没有设置 OPENAI_API_KEY" });

  try {
    const body = await readJson(req);
    const priceImage = String(body.priceImage || "");
    const productImage = String(body.productImage || "");
    if (!priceImage.startsWith("data:image/")) return sendJson(res, 400, { error: "请先上传价格标签图" });
    if (productImage && !productImage.startsWith("data:image/")) return sendJson(res, 400, { error: "商品图格式不正确" });

    const fields = await extractLabel(priceImage, productImage);
    const review = await reviewLabel(priceImage, fields);
    sendJson(res, 200, {
      fields: review.corrections,
      review: { ok: review.ok, issues: review.issues, confidence: review.confidence },
      model
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "AI 识别失败" });
  }
}

async function handleStatic(req, res) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = resolve(join(root, pathname));
    if (!filePath.startsWith(resolve(root))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": types[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/api/extract-label") return handleExtract(req, res);
  return handleStatic(req, res);
}).listen(port, "0.0.0.0", () => {
  console.log(`Costco label studio listening on http://0.0.0.0:${port}`);
});
