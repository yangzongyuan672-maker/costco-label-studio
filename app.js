const fieldDefs = [
  ["itemNo", "商品号"],
  ["brand", "品牌"],
  ["productName", "英文品名"],
  ["spec", "规格/尺码"],
  ["originalPrice", "原价"],
  ["discount", "折扣"],
  ["finalPrice", "到手价"],
  ["expiry", "到期日"],
  ["savingsLabel", "折扣标签"]
];

const state = {
  priceImage: "",
  productImage: "",
  fields: {
    itemNo: "",
    brand: "",
    productName: "",
    spec: "",
    originalPrice: "",
    discount: "",
    finalPrice: "",
    expiry: "",
    savingsLabel: "Instant Savings"
  }
};

const $ = (selector) => document.querySelector(selector);

function setStatus(text, isError = false) {
  const node = $("#status");
  node.textContent = text;
  node.style.color = isError ? "#b42318" : "#667085";
}

function fileToImageData(file, maxSide = 1400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.86));
    };
    img.onerror = () => reject(new Error("图片读取失败"));
    img.src = url;
  });
}

function renderFields() {
  $("#fields").innerHTML = fieldDefs.map(([key, label]) => `
    <div class="field">
      <label for="${key}">${label}</label>
      <input id="${key}" value="${escapeHtml(state.fields[key] || "")}" />
    </div>
  `).join("");
  fieldDefs.forEach(([key]) => {
    $(`#${key}`).addEventListener("input", (event) => {
      state.fields[key] = event.target.value;
      drawLabel();
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fitText(ctx, text, maxWidth, maxSize, minSize, weight = 700) {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px Georgia, "Times New Roman", serif`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 1;
  }
  return minSize;
}

function drawLabel() {
  const canvas = $("#labelCanvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const f = state.fields;
  ctx.fillStyle = "#f2f4ef";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#111827";
  ctx.font = "700 20px Georgia, 'Times New Roman', serif";
  ctx.fillText(f.itemNo || "ITEM #", 32, 36);

  const lines = [f.brand, f.productName, f.spec].filter(Boolean);
  let y = 68;
  for (const line of lines.slice(0, 4)) {
    const size = fitText(ctx, line.toUpperCase(), 420, 28, 18, 700);
    ctx.font = `700 ${size}px Georgia, "Times New Roman", serif`;
    ctx.fillText(line.toUpperCase(), 32, y);
    y += size + 9;
  }

  ctx.fillStyle = "#d7e86a";
  ctx.fillRect(32, 158, 456, 20);
  ctx.fillStyle = "#165a1f";
  ctx.font = "800 14px system-ui, sans-serif";
  ctx.fillText(f.savingsLabel || "Instant Savings", 38, 173);
  if (f.expiry) {
    ctx.fillStyle = "#111827";
    ctx.fillText(`EXP ${f.expiry}`, 238, 173);
  }

  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(32, 184);
  ctx.lineTo(728, 184);
  ctx.stroke();

  ctx.fillStyle = "#111827";
  ctx.font = "700 18px Georgia, 'Times New Roman', serif";
  if (f.originalPrice) ctx.fillText(f.originalPrice, 562, 104);
  if (f.discount) {
    ctx.fillStyle = "#2f7d32";
    ctx.fillText(f.discount, 655, 126);
  }

  const price = f.finalPrice || "0.00";
  const [dollars, cents = ""] = price.replace("$", "").split(".");
  ctx.fillStyle = "#111827";
  ctx.textAlign = "right";
  ctx.font = "800 108px Georgia, 'Times New Roman', serif";
  ctx.fillText(dollars || "0", 620, 287);
  ctx.textAlign = "left";
  ctx.font = "800 42px Georgia, 'Times New Roman', serif";
  if (cents) ctx.fillText(cents.padEnd(2, "0").slice(0, 2), 630, 236);
  ctx.textAlign = "start";

  ctx.fillStyle = "#6b7280";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText("PRICE AT REGISTER", 590, 174);
}

async function handleImage(input, preview, key, maxSide) {
  const file = input.files?.[0];
  if (!file) return;
  const dataUrl = await fileToImageData(file, maxSide);
  state[key] = dataUrl;
  preview.src = dataUrl;
  setStatus(key === "priceImage" ? "价格标签已上传，可以识别。" : "商品图已上传，可用于交叉校验。");
}

async function extractLabel() {
  if (!state.priceImage) {
    setStatus("请先上传价格标签图。", true);
    return;
  }
  $("#extractBtn").disabled = true;
  setStatus("AI 正在识别并二次复核...");
  try {
    const response = await fetch("/api/extract-label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceImage: state.priceImage, productImage: state.productImage })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "识别失败");
    state.fields = { ...state.fields, ...data.fields };
    renderFields();
    drawLabel();
    $("#downloadBtn").disabled = false;
    const issues = data.review?.issues || [];
    $("#issues").innerHTML = issues.length ? `需要确认：<br>${issues.map(escapeHtml).join("<br>")}` : "二次复核通过。";
    setStatus(`识别完成。模型：${data.model || ""}`);
  } catch (error) {
    setStatus(error.message || "识别失败", true);
  } finally {
    $("#extractBtn").disabled = false;
  }
}

function downloadLabel() {
  const link = document.createElement("a");
  link.href = $("#labelCanvas").toDataURL("image/jpeg", 0.95);
  link.download = `costco_label_${Date.now()}.jpg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

$("#priceInput").addEventListener("change", () => handleImage($("#priceInput"), $("#pricePreview"), "priceImage", 1400));
$("#productInput").addEventListener("change", () => handleImage($("#productInput"), $("#productPreview"), "productImage", 1200));
$("#extractBtn").addEventListener("click", extractLabel);
$("#downloadBtn").addEventListener("click", downloadLabel);

renderFields();
drawLabel();
