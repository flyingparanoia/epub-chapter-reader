import JSZip from "jszip";
import "./style.css";

const state = {
  book: null,
  fontScale: 1,
  readerFont: loadPreference("readerFont", "roboto"),
  sidebarOpen: !window.matchMedia("(max-width: 1024px)").matches,
  syncFrame: 0,
};

const app = document.querySelector("#app");

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">EP</div>
        <div>
          <p class="eyebrow">Vertical EPUB Reader</p>
          <h1>Chapter Stack</h1>
        </div>
      </div>
      <div class="topbar-actions">
        <label class="button button-primary file-picker">
          <input id="file-input" type="file" accept=".epub,application/epub+zip" hidden />
          <span>Open EPUB</span>
        </label>
        <button id="toggle-sidebar" class="button button-ghost" type="button">Contents</button>
      </div>
    </header>

    <div class="statusbar">
      <div id="book-meta" class="book-meta">
        <span class="meta-chip">No book loaded</span>
      </div>
      <div class="toolbar-controls">
        <label class="font-picker" for="font-family">
          <span class="control-label">Body font</span>
          <select id="font-family" class="select-control">
            <option value="roboto">Roboto</option>
            <option value="guardian">Guardian Sans</option>
            <option value="noto">Noto Sans</option>
          </select>
        </label>
        <button id="font-down" class="icon-button" type="button" aria-label="Decrease font size">A-</button>
        <span id="font-indicator" class="font-indicator">100%</span>
        <button id="font-up" class="icon-button" type="button" aria-label="Increase font size">A+</button>
      </div>
    </div>

    <div class="workspace">
      <aside id="sidebar" class="sidebar">
        <div class="sidebar-header">
          <div>
            <p class="eyebrow">Navigation</p>
            <h2>Table of Contents</h2>
          </div>
          <span id="chapter-count" class="count-pill">0</span>
        </div>
        <div id="toc-list" class="toc-list">
          <div class="placeholder-note">Upload an EPUB to build the chapter list.</div>
        </div>
      </aside>

      <main id="main-pane" class="main-pane">
        <section id="dropzone" class="empty-state">
          <div class="empty-panel">
            <div class="empty-icon">EPUB</div>
            <p class="eyebrow">Local File Reader</p>
            <h2>Open one EPUB, read it as a vertical chapter stack</h2>
            <p class="empty-copy">
              Each spine chapter becomes an individual reading card. Use the left navigation
              to jump between chapters and keep the flow in one continuous scroll.
            </p>
            <div class="empty-actions">
              <button id="empty-open" class="button button-primary" type="button">Choose EPUB</button>
              <span class="drop-hint">or drag a file into this window</span>
            </div>
          </div>
        </section>

        <div id="message" class="message" hidden></div>

        <section id="reader-panel" class="reader-panel" hidden>
          <div id="chapter-viewport" class="chapter-viewport"></div>
        </section>
      </main>
    </div>
  </div>
`;

const refs = {
  shell: document.querySelector(".app-shell"),
  fileInput: document.querySelector("#file-input"),
  toggleSidebar: document.querySelector("#toggle-sidebar"),
  sidebar: document.querySelector("#sidebar"),
  fontDown: document.querySelector("#font-down"),
  fontUp: document.querySelector("#font-up"),
  fontFamily: document.querySelector("#font-family"),
  fontIndicator: document.querySelector("#font-indicator"),
  bookMeta: document.querySelector("#book-meta"),
  chapterCount: document.querySelector("#chapter-count"),
  tocList: document.querySelector("#toc-list"),
  dropzone: document.querySelector("#dropzone"),
  emptyOpen: document.querySelector("#empty-open"),
  message: document.querySelector("#message"),
  readerPanel: document.querySelector("#reader-panel"),
  chapterViewport: document.querySelector("#chapter-viewport"),
  mainPane: document.querySelector("#main-pane"),
};

const mobileQuery = window.matchMedia("(max-width: 1024px)");
const defaultEmptyCopy = refs.dropzone.querySelector(".empty-copy").textContent.trim();

initialize();

function initialize() {
  syncSidebarState();
  syncFontScale();
  syncReaderFont();

  refs.fileInput.addEventListener("change", handleFileSelect);
  refs.emptyOpen.addEventListener("click", () => refs.fileInput.click());
  refs.toggleSidebar.addEventListener("click", () => {
    state.sidebarOpen = !state.sidebarOpen;
    syncSidebarState();
  });

  refs.fontDown.addEventListener("click", () => updateFontScale(-0.1));
  refs.fontUp.addEventListener("click", () => updateFontScale(0.1));
  refs.fontFamily.addEventListener("change", (event) => updateReaderFont(event.target.value));
  refs.chapterViewport.addEventListener("scroll", scheduleActiveChapterSync, { passive: true });
  refs.tocList.addEventListener("click", handleTocClick);
  refs.chapterViewport.addEventListener("click", handleChapterLinkClick);

  refs.mainPane.addEventListener("dragenter", handleDragState);
  refs.mainPane.addEventListener("dragover", handleDragState);
  refs.mainPane.addEventListener("dragleave", handleDragLeave);
  refs.mainPane.addEventListener("drop", handleDrop);

  mobileQuery.addEventListener("change", () => {
    state.sidebarOpen = !mobileQuery.matches;
    syncSidebarState();
  });

  document.addEventListener("click", (event) => {
    if (!mobileQuery.matches || !state.sidebarOpen) {
      return;
    }

    const insideSidebar = event.target.closest(".sidebar");
    const insideToggle = event.target.closest("#toggle-sidebar");

    if (!insideSidebar && !insideToggle) {
      state.sidebarOpen = false;
      syncSidebarState();
    }
  });
}

async function handleFileSelect(event) {
  const [file] = event.target.files ?? [];
  if (!file) {
    return;
  }

  await loadBook(file);
  refs.fileInput.value = "";
}

async function handleDrop(event) {
  event.preventDefault();
  refs.mainPane.classList.remove("is-dragging");

  const file = Array.from(event.dataTransfer?.files ?? []).find((candidate) =>
    /\.epub$/i.test(candidate.name),
  );

  if (!file) {
    showMessage("Drop a valid .epub file.", "error");
    return;
  }

  await loadBook(file);
}

function handleDragState(event) {
  event.preventDefault();
  refs.mainPane.classList.add("is-dragging");
}

function handleDragLeave(event) {
  if (event.relatedTarget && refs.mainPane.contains(event.relatedTarget)) {
    return;
  }

  refs.mainPane.classList.remove("is-dragging");
}

async function loadBook(file) {
  cleanupBook();
  setLoadingState(`Loading ${file.name}...`);

  try {
    const arrayBuffer = await file.arrayBuffer();
    const book = await parseEpub(arrayBuffer, file, setLoadingState);
    state.book = book;
    renderBook(book);
    clearMessage();
  } catch (error) {
    console.error(error);
    refs.readerPanel.hidden = true;
    refs.dropzone.hidden = false;
    showMessage(error.message || "Failed to open this EPUB file.", "error");
  }
}

function cleanupBook() {
  if (state.book?.cleanup) {
    state.book.cleanup();
  }

  state.book = null;
  refs.chapterViewport.innerHTML = "";
  refs.tocList.innerHTML = `<div class="placeholder-note">Upload an EPUB to build the chapter list.</div>`;
  refs.chapterCount.textContent = "0";
  refs.bookMeta.innerHTML = chip("No book loaded");
  refs.dropzone.querySelector(".empty-copy").textContent = defaultEmptyCopy;
}

function renderBook(book) {
  refs.dropzone.hidden = true;
  refs.readerPanel.hidden = false;
  refs.chapterCount.textContent = String(book.chapters.length);
  refs.bookMeta.innerHTML = [
    chip(book.title),
    book.creator ? chip(book.creator) : "",
    chip(book.fileSize),
    chip(`${book.chapters.length} chapters`),
  ].join("");

  refs.tocList.innerHTML = book.chapters
    .map(
      (chapter, index) => `
        <button class="toc-button" type="button" data-target="${chapter.id}">
          <span class="toc-index">${String(index + 1).padStart(2, "0")}</span>
          <span class="toc-title">${escapeHtml(chapter.title)}</span>
        </button>
      `,
    )
    .join("");

  refs.chapterViewport.innerHTML = book.chapters
    .map(
      (chapter, index) => `
        <article class="chapter-page" id="${chapter.id}" data-source-path="${chapter.path}">
          <div class="chapter-banner">
            <p class="chapter-kicker">Chapter ${index + 1}</p>
            <h3 class="chapter-title">${escapeHtml(chapter.title)}</h3>
          </div>
          <div class="book-content">${chapter.html}</div>
        </article>
      `,
    )
    .join("");

  if (mobileQuery.matches) {
    state.sidebarOpen = false;
    syncSidebarState();
  }

  requestAnimationFrame(() => {
    scheduleActiveChapterSync();
  });
}

function handleTocClick(event) {
  const button = event.target.closest("[data-target]");
  if (!button) {
    return;
  }

  button.blur();
  const targetId = button.dataset.target;
  scrollToChapter(targetId);

  if (mobileQuery.matches) {
    state.sidebarOpen = false;
    syncSidebarState();
  }
}

function handleChapterLinkClick(event) {
  const anchor = event.target.closest("a[href]");
  if (!anchor || !state.book) {
    return;
  }

  const href = anchor.getAttribute("href")?.trim();
  if (!href || /^mailto:/i.test(href) || /^tel:/i.test(href)) {
    return;
  }

  if (/^(https?:)?\/\//i.test(href)) {
    anchor.target = "_blank";
    anchor.rel = "noreferrer noopener";
    return;
  }

  const chapterElement = anchor.closest(".chapter-page");
  if (!chapterElement) {
    return;
  }

  event.preventDefault();

  const currentPath = chapterElement.dataset.sourcePath;
  const resolvedHref = resolvePath(currentPath, href);
  const targetPath = normalizeHrefPath(resolvedHref);
  const fragment = extractFragment(resolvedHref);
  const targetChapter = state.book.chapterByPath.get(targetPath);

  if (!targetChapter) {
    return;
  }

  scrollToChapter(targetChapter.id, fragment);
}

function scrollToChapter(targetId, fragment = "") {
  const chapter = document.getElementById(targetId);
  if (!chapter) {
    return;
  }

  scrollReaderToTarget(chapter);
  updateActiveChapter(targetId);

  if (fragment) {
    window.setTimeout(() => scrollToFragment(chapter, fragment), 250);
  }
}

function scrollToFragment(chapterElement, fragment) {
  if (!fragment) {
    return;
  }

  const escaped = CSS.escape(fragment);
  const target =
    chapterElement.querySelector(`#${escaped}`) ??
    chapterElement.querySelector(`[name="${escaped}"]`);

  if (target) {
    scrollReaderToTarget(target, 96);
  }
}

function scheduleActiveChapterSync() {
  if (state.syncFrame) {
    return;
  }

  state.syncFrame = requestAnimationFrame(() => {
    state.syncFrame = 0;
    syncActiveChapterFromScroll();
  });
}

function syncActiveChapterFromScroll() {
  const chapters = Array.from(refs.chapterViewport.querySelectorAll(".chapter-page"));
  if (!chapters.length) {
    return;
  }

  const viewportTop = refs.chapterViewport.getBoundingClientRect().top + 160;
  const visible = chapters.filter((chapter) => chapter.getBoundingClientRect().top <= viewportTop);
  const active = visible.at(-1) ?? chapters[0];

  updateActiveChapter(active.id);
}

function updateActiveChapter(targetId) {
  refs.tocList.querySelectorAll(".toc-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.target === targetId);
  });
}

function updateFontScale(delta) {
  state.fontScale = clamp(state.fontScale + delta, 0.8, 1.6);
  syncFontScale();
}

function updateReaderFont(nextFont) {
  state.readerFont = ["roboto", "guardian", "noto"].includes(nextFont) ? nextFont : "roboto";
  syncReaderFont();
  savePreference("readerFont", state.readerFont);
}

function syncFontScale() {
  document.documentElement.style.setProperty("--reader-font-scale", state.fontScale.toFixed(2));
  refs.fontIndicator.textContent = `${Math.round(state.fontScale * 100)}%`;
}

function syncReaderFont() {
  document.documentElement.dataset.readerFont = state.readerFont;
  refs.fontFamily.value = state.readerFont;
}

function syncSidebarState() {
  refs.shell.classList.toggle("is-sidebar-collapsed", !mobileQuery.matches && !state.sidebarOpen);
  refs.shell.classList.toggle("is-sidebar-open", mobileQuery.matches && state.sidebarOpen);
  refs.toggleSidebar.textContent = mobileQuery.matches
    ? "Menu"
    : state.sidebarOpen
      ? "Hide Contents"
      : "Show Contents";
}

function setLoadingState(text) {
  refs.dropzone.hidden = false;
  refs.readerPanel.hidden = true;
  refs.message.hidden = true;
  refs.dropzone.querySelector(".empty-copy").textContent = text;
}

function scrollReaderToTarget(target, offset = 20) {
  const viewportRect = refs.chapterViewport.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = refs.chapterViewport.scrollTop + (targetRect.top - viewportRect.top) - offset;
  refs.chapterViewport.scrollTo({
    top: Math.max(0, top),
    behavior: "smooth",
  });
}

function showMessage(text, tone = "info") {
  refs.message.hidden = false;
  refs.message.dataset.tone = tone;
  refs.message.textContent = text;
}

function clearMessage() {
  refs.message.hidden = true;
  refs.message.textContent = "";
  delete refs.message.dataset.tone;
}

async function parseEpub(arrayBuffer, file, reportProgress) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const objectUrlCache = new Map();
  const containerText = await readZipText(zip, "META-INF/container.xml");
  const containerDoc = parseXml(containerText, "container.xml");
  const rootfile = findFirstByLocalName(containerDoc, "rootfile");
  const packagePath = rootfile?.getAttribute("full-path");

  if (!packagePath) {
    throw new Error("The EPUB package document was not found.");
  }

  const packageText = await readZipText(zip, packagePath);
  const packageDoc = parseXml(packageText, packagePath);
  const manifest = extractManifest(packageDoc, packagePath);
  const metadata = extractMetadata(packageDoc);
  const spine = extractSpine(packageDoc, manifest);
  const tocEntries = await extractToc(zip, packageDoc, manifest);
  const tocLookup = new Map();

  tocEntries.forEach((entry) => {
    const key = normalizeHrefPath(entry.href);
    if (key && !tocLookup.has(key)) {
      tocLookup.set(key, entry.label);
    }
  });

  if (!spine.length) {
    throw new Error("This EPUB has no readable spine chapters.");
  }

  const chapters = [];

  for (let index = 0; index < spine.length; index += 1) {
    const item = spine[index];
    reportProgress(`Parsing chapter ${index + 1} / ${spine.length}...`);
    chapters.push(await buildChapter(zip, item, index, tocLookup, objectUrlCache));
  }

  const title = metadata.title || file.name.replace(/\.epub$/i, "");
  const creator = metadata.creator || metadata.publisher || "";
  const chapterByPath = new Map(chapters.map((chapter) => [chapter.path, chapter]));

  return {
    title,
    creator,
    chapters,
    chapterByPath,
    fileSize: formatBytes(file.size),
    cleanup() {
      objectUrlCache.forEach((url) => URL.revokeObjectURL(url));
      objectUrlCache.clear();
    },
  };
}

async function buildChapter(zip, item, index, tocLookup, objectUrlCache) {
  const rawMarkup = await readZipText(zip, item.path);
  const documentNode = new DOMParser().parseFromString(rawMarkup, "text/html");
  sanitizeChapterDocument(documentNode);
  await rewriteAssetUrls(documentNode, zip, objectUrlCache, item.path);
  await rewriteInlineStyles(documentNode, zip, objectUrlCache, item.path);

  const body = documentNode.body;
  if (!body) {
    throw new Error(`Could not parse chapter markup: ${item.path}`);
  }

  const title =
    tocLookup.get(normalizeHrefPath(item.path)) ||
    pickHeading(body) ||
    documentNode.title?.trim() ||
    `Chapter ${index + 1}`;

  return {
    id: `chapter-${index + 1}`,
    path: normalizeHrefPath(item.path),
    title: compactWhitespace(title),
    html: body.innerHTML,
  };
}

function sanitizeChapterDocument(documentNode) {
  documentNode
    .querySelectorAll(
      "script, iframe, object, embed, form, input, button, textarea, select, meta[http-equiv='refresh'], style, link, base",
    )
    .forEach((element) => element.remove());

  documentNode.querySelectorAll("*").forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const { name, value } = attribute;
      if (/^on/i.test(name)) {
        element.removeAttribute(name);
      }

      if ((name === "href" || name === "src") && /^javascript:/i.test(value)) {
        element.removeAttribute(name);
      }
    });
  });
}

async function rewriteAssetUrls(documentNode, zip, objectUrlCache, basePath) {
  const srcTargets = Array.from(documentNode.querySelectorAll("[src], [poster]"));
  const hrefTargets = Array.from(documentNode.querySelectorAll("img[href], image[href], image[xlink\\:href]"));

  for (const element of srcTargets) {
    await rewriteAttributeUrl(element, "src", zip, objectUrlCache, basePath);
    await rewriteAttributeUrl(element, "poster", zip, objectUrlCache, basePath);

    if (element.hasAttribute("srcset")) {
      const rewritten = await rewriteSrcset(element.getAttribute("srcset"), zip, objectUrlCache, basePath);
      if (rewritten) {
        element.setAttribute("srcset", rewritten);
      }
    }
  }

  for (const element of hrefTargets) {
    await rewriteAttributeUrl(element, "href", zip, objectUrlCache, basePath);
    await rewriteAttributeUrl(element, "xlink:href", zip, objectUrlCache, basePath);
  }
}

async function rewriteInlineStyles(documentNode, zip, objectUrlCache, basePath) {
  const styledElements = Array.from(documentNode.querySelectorAll("[style]"));

  for (const element of styledElements) {
    const updatedStyle = await rewriteCssUrls(element.getAttribute("style"), zip, objectUrlCache, basePath);
    if (updatedStyle) {
      element.setAttribute("style", updatedStyle);
    }
  }
}

async function rewriteAttributeUrl(element, attributeName, zip, objectUrlCache, basePath) {
  const rawValue = element.getAttribute(attributeName);
  if (!rawValue || isExternalUrl(rawValue) || rawValue.startsWith("#")) {
    return;
  }

  const path = normalizeHrefPath(resolvePath(basePath, rawValue));
  const fragment = extractFragment(rawValue);
  const objectUrl = await getObjectUrl(zip, path, objectUrlCache);

  if (objectUrl) {
    element.setAttribute(attributeName, fragment ? `${objectUrl}#${fragment}` : objectUrl);
  }
}

async function rewriteSrcset(value, zip, objectUrlCache, basePath) {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const rewrittenEntries = await Promise.all(
    entries.map(async (entry) => {
      const [urlCandidate, descriptor] = entry.split(/\s+/, 2);
      if (!urlCandidate || isExternalUrl(urlCandidate)) {
        return entry;
      }

      const path = normalizeHrefPath(resolvePath(basePath, urlCandidate));
      const objectUrl = await getObjectUrl(zip, path, objectUrlCache);
      if (!objectUrl) {
        return entry;
      }

      return descriptor ? `${objectUrl} ${descriptor}` : objectUrl;
    }),
  );

  return rewrittenEntries.join(", ");
}

async function rewriteCssUrls(value, zip, objectUrlCache, basePath) {
  if (!value) {
    return value;
  }

  const matches = Array.from(value.matchAll(/url\(([^)]+)\)/gi));
  if (!matches.length) {
    return value;
  }

  let rewritten = value;

  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const rawUrl = match[1].trim().replace(/^['"]|['"]$/g, "");

    if (!rawUrl || isExternalUrl(rawUrl) || rawUrl.startsWith("#")) {
      continue;
    }

    const path = normalizeHrefPath(resolvePath(basePath, rawUrl));
    const fragment = extractFragment(rawUrl);
    const objectUrl = await getObjectUrl(zip, path, objectUrlCache);

    if (!objectUrl) {
      continue;
    }

    const replacement = `url("${fragment ? `${objectUrl}#${fragment}` : objectUrl}")`;
    rewritten =
      rewritten.slice(0, match.index) +
      replacement +
      rewritten.slice(match.index + match[0].length);
  }

  return rewritten;
}

async function extractToc(zip, packageDoc, manifest) {
  const navItem = Array.from(manifest.values()).find((item) => item.properties.includes("nav"));
  const spineNode = findFirstByLocalName(packageDoc, "spine");
  const ncxId = spineNode?.getAttribute("toc");
  const tocItem =
    navItem ||
    (ncxId ? manifest.get(ncxId) : null) ||
    Array.from(manifest.values()).find((item) => /ncx/i.test(item.mediaType));

  if (!tocItem) {
    return [];
  }

  const tocMarkup = await readZipText(zip, tocItem.path);

  if (/ncx/i.test(tocItem.mediaType) || /\.ncx$/i.test(tocItem.path)) {
    const tocDoc = parseXml(tocMarkup, tocItem.path);
    return findAllByLocalName(tocDoc, "navPoint")
      .map((navPoint) => {
        const labelNode = findFirstByLocalName(navPoint, "text");
        const contentNode = findFirstByLocalName(navPoint, "content");
        const src = contentNode?.getAttribute("src") || "";
        return {
          label: compactWhitespace(labelNode?.textContent || ""),
          href: resolvePath(tocItem.path, src),
        };
      })
      .filter((entry) => entry.label && entry.href);
  }

  const tocDoc = new DOMParser().parseFromString(tocMarkup, "text/html");
  const navNodes = Array.from(tocDoc.querySelectorAll("nav"));
  const tocNode =
    navNodes.find((nav) => /\btoc\b/i.test(nav.getAttribute("epub:type") || "")) ||
    navNodes.find((nav) => /\btoc\b/i.test(nav.getAttribute("role") || "")) ||
    navNodes[0] ||
    tocDoc.body;

  return Array.from(tocNode.querySelectorAll("a[href]"))
    .map((anchor) => ({
      label: compactWhitespace(anchor.textContent || ""),
      href: resolvePath(tocItem.path, anchor.getAttribute("href") || ""),
    }))
    .filter((entry) => entry.label && entry.href);
}

function extractMetadata(packageDoc) {
  const metadataNode = findFirstByLocalName(packageDoc, "metadata");
  if (!metadataNode) {
    return {};
  }

  return {
    title: textFromLocalName(metadataNode, "title"),
    creator: textFromLocalName(metadataNode, "creator"),
    publisher: textFromLocalName(metadataNode, "publisher"),
  };
}

function extractManifest(packageDoc, packagePath) {
  const manifestNode = findFirstByLocalName(packageDoc, "manifest");
  const manifest = new Map();

  if (!manifestNode) {
    return manifest;
  }

  findAllByLocalName(manifestNode, "item").forEach((itemNode) => {
    const id = itemNode.getAttribute("id");
    const href = itemNode.getAttribute("href");
    if (!id || !href) {
      return;
    }

    manifest.set(id, {
      id,
      href,
      path: normalizeHrefPath(resolvePath(packagePath, href)),
      mediaType: itemNode.getAttribute("media-type") || "",
      properties: itemNode.getAttribute("properties") || "",
    });
  });

  return manifest;
}

function extractSpine(packageDoc, manifest) {
  const spineNode = findFirstByLocalName(packageDoc, "spine");
  if (!spineNode) {
    return [];
  }

  return findAllByLocalName(spineNode, "itemref")
    .map((itemrefNode) => manifest.get(itemrefNode.getAttribute("idref")))
    .filter((item) => item && /(xhtml|html)/i.test(item.mediaType || item.href));
}

async function readZipText(zip, path) {
  const file = zip.file(normalizeHrefPath(path));
  if (!file) {
    throw new Error(`Missing EPUB resource: ${path}`);
  }

  return file.async("string");
}

async function getObjectUrl(zip, path, objectUrlCache) {
  if (!path) {
    return null;
  }

  if (objectUrlCache.has(path)) {
    return objectUrlCache.get(path);
  }

  const file = zip.file(path);
  if (!file) {
    return null;
  }

  const blob = await file.async("blob");
  const objectUrl = URL.createObjectURL(blob);
  objectUrlCache.set(path, objectUrl);
  return objectUrl;
}

function parseXml(markup, label) {
  const documentNode = new DOMParser().parseFromString(markup, "application/xml");
  if (documentNode.querySelector("parsererror")) {
    throw new Error(`Failed to parse ${label}.`);
  }
  return documentNode;
}

function findAllByLocalName(node, localName) {
  return Array.from(node.getElementsByTagName("*")).filter((element) => element.localName === localName);
}

function findFirstByLocalName(node, localName) {
  return findAllByLocalName(node, localName)[0] || null;
}

function textFromLocalName(node, localName) {
  return compactWhitespace(findFirstByLocalName(node, localName)?.textContent || "");
}

function pickHeading(body) {
  const heading = body.querySelector("h1, h2, h3, title");
  return compactWhitespace(heading?.textContent || "");
}

function resolvePath(basePath, candidate) {
  if (!candidate) {
    return "";
  }

  if (isExternalUrl(candidate)) {
    return candidate;
  }

  const fragment = extractFragment(candidate);
  const cleanCandidate = stripFragment(candidate);
  if (!cleanCandidate) {
    return `${normalizeHrefPath(basePath)}${fragment ? `#${fragment}` : ""}`;
  }

  if (cleanCandidate.startsWith("/")) {
    const rooted = normalizeHrefPath(cleanCandidate);
    return `${rooted}${fragment ? `#${fragment}` : ""}`;
  }

  const baseDirectory = dirname(basePath);
  const normalized = normalizeHrefPath(`${baseDirectory}/${cleanCandidate}`);
  return `${normalized}${fragment ? `#${fragment}` : ""}`;
}

function dirname(path) {
  const normalized = normalizeHrefPath(path);
  const parts = normalized.split("/");
  parts.pop();
  return parts.join("/");
}

function normalizeHrefPath(path) {
  const cleanPath = stripFragment(path).split("?")[0].replace(/\\/g, "/");
  const segments = cleanPath.split("/");
  const normalizedSegments = [];

  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      normalizedSegments.pop();
      continue;
    }

    normalizedSegments.push(safeDecodeURIComponent(segment));
  }

  return normalizedSegments.join("/");
}

function stripFragment(value) {
  return value.split("#")[0];
}

function extractFragment(value) {
  const [, fragment = ""] = value.split("#");
  return fragment;
}

function isExternalUrl(value) {
  return /^(?:[a-z]+:|\/\/)/i.test(value) || value.startsWith("data:");
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function compactWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 100 || unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function chip(text) {
  return `<span class="meta-chip">${escapeHtml(text)}</span>`;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function loadPreference(key, fallback) {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function savePreference(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in private windows or restricted environments.
  }
}
