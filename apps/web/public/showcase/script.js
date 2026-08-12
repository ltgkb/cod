const DOWNLOAD_URLS = {
  windows: "",
  macos: "",
  linux: ""
};

const PLATFORM_NAMES = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux"
};

const platformTabs = [...document.querySelectorAll("[data-platform]")];
const selectedPlatform = document.querySelector("#selectedPlatform");
const downloadButton = document.querySelector("#downloadButton");
const downloadNote = document.querySelector("#downloadNote");
const toast = document.querySelector("#toast");
const registerButton = document.querySelector("#registerButton");
const heroDownloadButton = document.querySelector("#heroDownloadButton");
let activePlatform = "windows";
let toastTimer;

async function revealRegistrationWhenAvailable() {
  if (!registerButton) return;
  try {
    const response = await fetch("/api/capabilities", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const capabilities = await response.json();
    if (capabilities?.authentication?.registrationEnabled === true) {
      registerButton.hidden = false;
      if (heroDownloadButton) heroDownloadButton.hidden = true;
    }
  } catch {
    // Registration is fail-closed. Login and the public preview remain usable.
  }
}

void revealRegistrationWhenAvailable();

function detectPlatform() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();

  if (platform.includes("mac")) return "macos";
  if (platform.includes("linux") || platform.includes("x11")) return "linux";
  return "windows";
}

function selectPlatform(platform) {
  if (!PLATFORM_NAMES[platform]) return;

  activePlatform = platform;
  selectedPlatform.textContent = PLATFORM_NAMES[platform];
  downloadNote.textContent = DOWNLOAD_URLS[platform]
    ? `${PLATFORM_NAMES[platform]} 安装包已可下载。`
    : "查看对应平台的当前发布状态。";

  platformTabs.forEach((tab) => {
    tab.setAttribute("aria-pressed", String(tab.dataset.platform === platform));
  });
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

platformTabs.forEach((tab) => {
  tab.addEventListener("click", () => selectPlatform(tab.dataset.platform));
});

downloadButton.addEventListener("click", () => {
  const url = DOWNLOAD_URLS[activePlatform];

  if (url) {
    window.location.assign(url);
    return;
  }

  window.location.assign("/download/");
});

selectPlatform(detectPlatform());

const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const chatThread = document.querySelector("#chatThread");
const chatEmpty = document.querySelector("#chatEmpty");
const clearChat = document.querySelector("#clearChat");
const sendButton = chatForm.querySelector("button");

function createMessage(content, role) {
  const message = document.createElement("div");
  message.className = `message message-${role}`;
  message.textContent = content;
  return message;
}

function createTypingMessage() {
  const message = document.createElement("div");
  message.className = "message message-cod typing";
  message.setAttribute("aria-label", "COD 正在思考");

  for (let index = 0; index < 3; index += 1) {
    message.append(document.createElement("span"));
  }

  return message;
}

function getDemoResponse(question) {
  const normalized = question.toLowerCase();

  if (/代码|报错|bug|code|error/.test(normalized)) {
    return "可以。把代码或错误信息发给我，我会先定位问题，再给出可验证的修改建议。";
  }

  if (/计划|工作|任务|plan|task/.test(normalized)) {
    return "我会先把目标拆成清晰步骤，标出依赖和优先级，再陪你逐项完成。";
  }

  if (/安装|下载|windows|mac|linux/.test(normalized)) {
    return "网页已经支持 Windows、macOS 和 Linux。安装包接入后就能直接下载。";
  }

  return "明白。你可以继续补充背景，我会保留对话上下文，并把回答变得更具体。";
}

function scrollChatToEnd() {
  chatThread.scrollTo({
    top: chatThread.scrollHeight,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  });
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = chatInput.value.trim();
  if (!question || sendButton.disabled) return;

  chatEmpty.hidden = true;
  chatThread.hidden = false;
  chatThread.append(createMessage(question, "user"));
  chatInput.value = "";
  sendButton.disabled = true;
  sendButton.textContent = "思考中";

  const typingMessage = createTypingMessage();
  chatThread.append(typingMessage);
  scrollChatToEnd();

  window.setTimeout(() => {
    typingMessage.replaceWith(createMessage(getDemoResponse(question), "cod"));
    sendButton.disabled = false;
    sendButton.textContent = "发送";
    chatInput.focus();
    scrollChatToEnd();
  }, 720);
});

clearChat.addEventListener("click", () => {
  chatThread.replaceChildren();
  chatThread.hidden = true;
  chatEmpty.hidden = false;
  chatInput.focus();
});

const revealItems = [...document.querySelectorAll(".reveal")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (reduceMotion || !("IntersectionObserver" in window)) {
  revealItems.forEach((item) => item.classList.add("is-visible"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.14, rootMargin: "0px 0px -4%" }
  );

  revealItems.forEach((item) => observer.observe(item));
}

if (!reduceMotion) {
  document.querySelectorAll(".glass-surface").forEach((surface) => {
    let frameId;

    surface.addEventListener("pointermove", (event) => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const bounds = surface.getBoundingClientRect();
        const x = ((event.clientX - bounds.left) / bounds.width) * 100;
        const y = ((event.clientY - bounds.top) / bounds.height) * 100;
        surface.style.setProperty("--glass-x", `${x}%`);
        surface.style.setProperty("--glass-y", `${y}%`);
      });
    });

    surface.addEventListener("pointerleave", () => {
      window.cancelAnimationFrame(frameId);
      surface.style.setProperty("--glass-x", "50%");
      surface.style.setProperty("--glass-y", "0%");
    });
  });
}
