const FALLBACK_MANIFEST = {
  channel: "stable",
  updatedAt: "2026-08-11",
  platforms: {
    macos: {
      label: "macOS",
      status: "preparing",
      statusLabel: "正在完成签名与公证",
      version: null,
      architecture: "Apple 芯片",
      requirements: "macOS 12 或更高版本",
      size: null,
      sha256: null,
      url: null,
      note: "Apple 芯片版正在完成 Developer ID 签名和公证。"
    },
    windows: {
      label: "Windows",
      status: "preparing",
      statusLabel: "正在完成签名与验收",
      version: null,
      architecture: "x64",
      requirements: "Windows 10 或更高版本",
      size: null,
      sha256: null,
      url: null,
      note: "Windows 安装程序正在完成代码签名与跨平台验收。"
    },
    linux: {
      label: "Linux",
      status: "preparing",
      statusLabel: "正在完成发布验收",
      version: null,
      architecture: "x64",
      requirements: "glibc 2.28+ 的 64 位 Linux（如 Debian 10+ / Ubuntu 20.04+）",
      size: null,
      sha256: null,
      url: null,
      note: "AppImage 和 Deb 安装包正在完成发布验收。"
    }
  }
};

const platformTabs = [...document.querySelectorAll("[data-platform]")];
const releasePanel = document.querySelector("#releasePanel");
const releasePlatform = document.querySelector("#releasePlatform");
const releaseTitle = document.querySelector("#releaseTitle");
const releaseState = document.querySelector("#releaseState");
const releaseVersion = document.querySelector("#releaseVersion");
const releaseArchitecture = document.querySelector("#releaseArchitecture");
const releaseRequirements = document.querySelector("#releaseRequirements");
const releaseSize = document.querySelector("#releaseSize");
const releaseNote = document.querySelector("#releaseNote");
const releaseIntegrity = document.querySelector("#releaseIntegrity");
const releaseChecksum = document.querySelector("#releaseChecksum");
const downloadButton = document.querySelector("#downloadButton");

let manifest = FALLBACK_MANIFEST;
let manifestUnavailable = false;
let activePlatform = "macos";

function detectPlatform() {
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();

  if (/android|iphone|ipad|ipod|mobile/.test(userAgent)) return null;
  if (/cros/.test(userAgent)) return null;
  if (platform.includes("mac") || userAgent.includes("macintosh")) return "macos";
  if (platform.includes("win") || userAgent.includes("windows")) return "windows";
  if (platform.includes("linux") || userAgent.includes("x11")) return "linux";
  return null;
}

function safeDownloadUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value, window.location.href);
    if (url.protocol === "https:") return url.href;
    const isLoopback = (hostname) => hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
    if (url.protocol !== "http:"
      || window.location.protocol !== "http:"
      || !isLoopback(window.location.hostname)
      || !isLoopback(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function selectPlatform(platform, options = {}) {
  const entry = manifest.platforms[platform];
  if (!entry) return;

  activePlatform = platform;
  const tab = platformTabs.find((item) => item.dataset.platform === platform);

  platformTabs.forEach((item) => {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  });

  releasePanel.setAttribute("aria-labelledby", tab.id);
  releasePlatform.textContent = entry.label;
  releaseTitle.textContent = `COD for ${entry.label}`;
  releaseState.textContent = manifestUnavailable ? "发布状态暂不可用" : entry.statusLabel;
  releaseState.classList.toggle("is-available", entry.status === "available");
  releaseVersion.textContent = entry.version || "待公布";
  releaseArchitecture.textContent = entry.architecture || "待公布";
  releaseRequirements.textContent = entry.requirements || "待公布";
  releaseSize.textContent = entry.size || "待公布";

  const mobileHint = detectPlatform() === null
    ? " 当前正在移动设备上浏览，请在电脑上完成安装。"
    : "";
  releaseNote.textContent = manifestUnavailable
    ? `暂时无法读取最新发布状态。${mobileHint || "你仍可继续使用 COD 网页版。"}`
    : `${entry.note}${mobileHint}`;

  const downloadUrl = entry.status === "available" ? safeDownloadUrl(entry.url) : null;
  if (downloadUrl) {
    downloadButton.href = downloadUrl;
    downloadButton.textContent = `下载 ${entry.label}`;
    downloadButton.removeAttribute("aria-disabled");
    downloadButton.removeAttribute("tabindex");
    downloadButton.classList.remove("is-disabled");
  } else {
    downloadButton.removeAttribute("href");
    downloadButton.textContent = "即将开放";
    downloadButton.setAttribute("aria-disabled", "true");
    downloadButton.setAttribute("tabindex", "-1");
    downloadButton.classList.add("is-disabled");
  }

  if (entry.sha256) {
    releaseChecksum.textContent = entry.sha256;
    releaseIntegrity.hidden = false;
  } else {
    releaseChecksum.textContent = "";
    releaseIntegrity.hidden = true;
  }

  if (options.focus) tab.focus();
}

platformTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectPlatform(tab.dataset.platform));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (index + direction + platformTabs.length) % platformTabs.length;
    selectPlatform(platformTabs[nextIndex].dataset.platform, { focus: true });
  });
});

downloadButton.addEventListener("click", (event) => {
  if (downloadButton.getAttribute("aria-disabled") === "true") event.preventDefault();
});

async function loadManifest() {
  try {
    const response = await fetch("./release-manifest.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Manifest request failed with ${response.status}`);
    const data = await response.json();
    if (!data || typeof data.platforms !== "object") throw new Error("Manifest is invalid");

    manifest = {
      ...FALLBACK_MANIFEST,
      ...data,
      platforms: Object.fromEntries(
        Object.entries(FALLBACK_MANIFEST.platforms).map(([key, fallback]) => [
          key,
          { ...fallback, ...(data.platforms[key] || {}) }
        ])
      )
    };
  } catch {
    manifestUnavailable = true;
  }

  selectPlatform(activePlatform);
}

const detectedPlatform = detectPlatform();
activePlatform = detectedPlatform || "macos";
selectPlatform(activePlatform);
void loadManifest();
