import JSZip from "jszip";
import "./style.css";

const state = {
  book: null,
  fontScale: 1,
  readerFont: loadPreference("readerFont", "roboto"),
  sidebarOpen: !window.matchMedia("(max-width: 1024px)").matches,
  loadVersion: 0,
  chapterRequestVersion: 0,
  activeChapterId: "",
  isLoadingBook: false,
  isLoadingChapter: false,
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
              The app reads the table of contents first, then renders chapters on demand.
              Pick a chapter from the left and the reader will load just that section.
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
  syncLoadingState();

  refs.fileInput.addEventListener("change", handleFileSelect);
  refs.emptyOpen.addEventListener("click", () => refs.fileInput.click());
  refs.toggleSidebar.addEventListener("click", () => {
    state.sidebarOpen = !state.sidebarOpen;
    syncSidebarState();
  });

  refs.fontDown.addEventListener("click", () => updateFontScale(-0.1));
  refs.fontUp.addEventListener("click", () => updateFontScale(0.1));
  refs.fontFamily.addEventListener("change", (event) => updateReaderFont(event.target.value));
  refs.tocList.addEventListener("click", handleTocClick);
  refs.chapterViewport.addEventListener("click", handleReaderPaneClick);

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
  const loadVersion = ++state.loadVersion;
  cleanupBook();
  setLoadingState(`Opening ${file.name}...`);
  state.isLoadingBook = true;
  syncLoadingState();

  try {
    const arrayBuffer = await file.arrayBuffer();
    if (loadVersion !== state.loadVersion) {
      return;
    }

    const book = await parseEpub(arrayBuffer, file, (text) => {
      if (loadVersion === state.loadVersion) {
        setLoadingState(text);
      }
    });

    if (loadVersion !== state.loadVersion) {
      book.cleanup?.();
      return;
    }

    state.book = book;
    renderBookShell(book);
    clearMessage();
    await selectChapter(book.chapters[0]?.id, { reason: "Loading first chapter..." });
  } catch (error) {
    if (loadVersion !== state.loadVersion) {
      return;
    }
    console.error(error);
    refs.readerPanel.hidden = true;
    refs.dropzone.hidden = false;
    showMessage(error.message || "Failed to open this EPUB file.", "error");
  } finally {
    if (loadVersion === state.loadVersion) {
      state.isLoadingBook = false;
      syncLoadingState();
    }
  }
}

function cleanupBook() {
  if (state.book?.cleanup) {
    state.book.cleanup();
  }

  state.book = null;
  state.activeChapterId = "";
  state.chapterRequestVersion += 1;
  state.isLoadingChapter = false;
  refs.chapterViewport.innerHTML = "";
  refs.tocList.innerHTML = `<div class="placeholder-note">Upload an EPUB to build the chapter list.</div>`;
  refs.chapterCount.textContent = "0";
  refs.bookMeta.innerHTML = chip("No book loaded");
  refs.dropzone.querySelector(".empty-copy").textContent = defaultEmptyCopy;
}

function renderBookShell(book) {
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
  refs.chapterViewport.replaceChildren(
    buildReaderToolbar(null),
    buildReaderPlaceholder(
      "Select a chapter",
      "Pick a chapter from the table of contents. The reader now loads chapters on demand instead of rendering the whole book at once.",
    ),
  );

  if (mobileQuery.matches) {
    state.sidebarOpen = false;
    syncSidebarState();
  }
}

async function selectChapter(targetId, options = {}) {
  if (!state.book || !targetId) {
    return;
  }

  const chapter = state.book.chapterById.get(targetId);
  if (!chapter) {
    return;
  }

  const currentBook = state.book;
  const loadVersion = state.loadVersion;
  const requestVersion = ++state.chapterRequestVersion;
  state.activeChapterId = targetId;
  updateActiveChapter(targetId);
  scrollTocButtonIntoView(targetId);

  if (chapter.loadState === "ready" && chapter.html) {
    renderChapter(chapter);
    if (options.fragment) {
      requestAnimationFrame(() => scrollToFragment(options.fragment));
    } else {
      refs.chapterViewport.scrollTop = 0;
    }
    clearMessage();
    prefetchNeighborChapters(chapter.index);
    if (mobileQuery.matches) {
      state.sidebarOpen = false;
      syncSidebarState();
    }
    return;
  }

  state.isLoadingChapter = true;
  renderChapterLoading(chapter, options.reason || "Loading chapter...");

  try {
    const loadedChapter = await loadChapterContent(currentBook, chapter);
    if (
      currentBook !== state.book ||
      loadVersion !== state.loadVersion ||
      requestVersion !== state.chapterRequestVersion ||
      state.activeChapterId !== targetId
    ) {
      return;
    }

    renderChapter(loadedChapter);
    clearMessage();
    if (options.fragment) {
      requestAnimationFrame(() => scrollToFragment(options.fragment));
    } else {
      refs.chapterViewport.scrollTop = 0;
    }
    prefetchNeighborChapters(loadedChapter.index);
  } catch (error) {
    if (
      currentBook !== state.book ||
      loadVersion !== state.loadVersion ||
      requestVersion !== state.chapterRequestVersion
    ) {
      return;
    }

    console.error("Failed to load chapter", chapter.path, error);
    refs.chapterViewport.replaceChildren(
      buildReaderToolbar(chapter),
      buildBrokenChapterElement(chapter, chapter.index, error),
    );
    showMessage(error?.message || "Failed to render this chapter.", "error");
  } finally {
    if (
      currentBook === state.book &&
      loadVersion === state.loadVersion &&
      requestVersion === state.chapterRequestVersion
    ) {
      state.isLoadingChapter = false;
      renderToolbarState();
    }
  }

  if (mobileQuery.matches) {
    state.sidebarOpen = false;
    syncSidebarState();
  }
}

function renderChapterLoading(chapter, text) {
  refs.dropzone.hidden = true;
  refs.readerPanel.hidden = false;
  refs.chapterViewport.replaceChildren(
    buildReaderToolbar(chapter),
    buildReaderPlaceholder(chapter.title, text),
  );
}

function renderChapter(chapter) {
  refs.dropzone.hidden = true;
  refs.readerPanel.hidden = false;
  refs.chapterViewport.replaceChildren(buildReaderToolbar(chapter), buildChapterElement(chapter));
}

function renderToolbarState() {
  const toolbar = refs.chapterViewport.querySelector(".chapter-toolbar");
  if (!toolbar || !state.book) {
    return;
  }

  const chapter = state.book.chapterById.get(state.activeChapterId) || null;
  const nextToolbar = buildReaderToolbar(chapter);
  toolbar.replaceWith(nextToolbar);
}

function prefetchNeighborChapters(index) {
  if (!state.book) {
    return;
  }

  [index - 1, index + 1].forEach((candidateIndex) => {
    const chapter = state.book.chapters[candidateIndex];
    if (!chapter || chapter.loadState === "ready" || chapter.loadState === "loading") {
      return;
    }

    loadChapterContent(state.book, chapter).catch((error) => {
      console.debug("Neighbor prefetch skipped", chapter.path, error);
    });
  });
}

function scrollTocButtonIntoView(targetId) {
  const button = refs.tocList.querySelector(`[data-target="${targetId}"]`);
  button?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function buildChapterElement(chapter) {
  const article = document.createElement("article");
  article.className = "chapter-page";
  article.id = chapter.id;
  article.dataset.sourcePath = chapter.path;

  const banner = document.createElement("div");
  banner.className = "chapter-banner";

  const kicker = document.createElement("p");
  kicker.className = "chapter-kicker";
  kicker.textContent = `Chapter ${chapter.index + 1}`;

  const title = document.createElement("h3");
  title.className = "chapter-title";
  title.textContent = chapter.title;

  const content = document.createElement("div");
  content.className = "book-content";

  const template = document.createElement("template");
  template.innerHTML = chapter.html;
  content.append(template.content.cloneNode(true));

  banner.append(kicker, title);
  article.append(banner, content);
  return article;
}

function buildBrokenChapterElement(chapter, index, error) {
  const article = document.createElement("article");
  article.className = "chapter-page";
  article.id = chapter.id;
  article.dataset.sourcePath = chapter.path;

  const banner = document.createElement("div");
  banner.className = "chapter-banner";

  const kicker = document.createElement("p");
  kicker.className = "chapter-kicker";
  kicker.textContent = `Chapter ${index + 1}`;

  const title = document.createElement("h3");
  title.className = "chapter-title";
  title.textContent = chapter.title;

  const content = document.createElement("div");
  content.className = "book-content chapter-error";
  content.innerHTML = `
    <p><strong>Chapter failed to render.</strong></p>
    <p>${escapeHtml(error?.message || "Unknown rendering error.")}</p>
    <p class="chapter-error-path">${escapeHtml(chapter.path)}</p>
  `;

  banner.append(kicker, title);
  article.append(banner, content);
  return article;
}

function buildReaderToolbar(chapter) {
  const toolbar = document.createElement("div");
  toolbar.className = "chapter-toolbar";

  const previousChapter = chapter ? state.book?.chapters?.[chapter.index - 1] : null;
  const nextChapter = chapter ? state.book?.chapters?.[chapter.index + 1] : null;

  const previousButton = document.createElement("button");
  previousButton.className = "button button-ghost chapter-nav-button";
  previousButton.type = "button";
  previousButton.textContent = "Previous";
  previousButton.disabled = !previousChapter || state.isLoadingChapter;
  if (previousChapter) {
    previousButton.dataset.navTarget = previousChapter.id;
  }

  const position = document.createElement("div");
  position.className = "chapter-position";
  position.innerHTML = chapter
    ? `<span class="meta-chip">Chapter ${chapter.index + 1}</span><span class="meta-chip">${escapeHtml(chapter.title)}</span>`
    : `<span class="meta-chip">No chapter selected</span>`;

  const nextButton = document.createElement("button");
  nextButton.className = "button button-ghost chapter-nav-button";
  nextButton.type = "button";
  nextButton.textContent = "Next";
  nextButton.disabled = !nextChapter || state.isLoadingChapter;
  if (nextChapter) {
    nextButton.dataset.navTarget = nextChapter.id;
  }

  toolbar.append(previousButton, position, nextButton);
  return toolbar;
}

function buildReaderPlaceholder(title, copy) {
  const panel = document.createElement("div");
  panel.className = "chapter-placeholder";
  panel.innerHTML = `
    <div class="chapter-placeholder-card">
      <p class="eyebrow">On-demand Chapter Render</p>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(copy)}</p>
    </div>
  `;
  return panel;
}

function handleReaderPaneClick(event) {
  const navButton = event.target.closest("[data-nav-target]");
  if (navButton) {
    event.preventDefault();
    void selectChapter(navButton.dataset.navTarget);
    return;
  }

  handleChapterLinkClick(event);
}

function handleTocClick(event) {
  const button = event.target.closest("[data-target]");
  if (!button) {
    return;
  }

  button.blur();
  void selectChapter(button.dataset.target);
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

  void selectChapter(targetChapter.id, { fragment });
}

function scrollToChapter(targetId, fragment = "") {
  void selectChapter(targetId, { fragment });
}

function scrollToFragment(fragment) {
  if (!fragment) {
    return;
  }

  const escaped = CSS.escape(fragment);
  const target =
    refs.chapterViewport.querySelector(`#${escaped}`) ??
    refs.chapterViewport.querySelector(`[name="${escaped}"]`);

  if (target) {
    scrollReaderToTarget(target, 96);
  }
}

function updateActiveChapter(targetId) {
  refs.tocList.querySelectorAll(".toc-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.target === targetId);
  });
}

function syncRenderedTocTitle(chapter) {
  const titleNode = refs.tocList.querySelector(`[data-target="${chapter.id}"] .toc-title`);
  if (titleNode) {
    titleNode.textContent = chapter.title;
  }
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

function syncLoadingState() {
  refs.fileInput.disabled = state.isLoadingBook;
  refs.emptyOpen.disabled = state.isLoadingBook;
  refs.toggleSidebar.disabled = state.isLoadingBook;
  refs.shell.classList.toggle("is-loading", state.isLoadingBook);
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
  reportProgress("Reading EPUB package...");
  const zip = await JSZip.loadAsync(arrayBuffer);
  const objectUrlCache = new Map();
  const containerText = await readZipText(zip, "META-INF/container.xml");
  const containerDoc = parseXml(containerText, "container.xml");
  const rootfile = findFirstByLocalName(containerDoc, "rootfile");
  const packagePath = rootfile?.getAttribute("full-path");

  if (!packagePath) {
    throw new Error("The EPUB package document was not found.");
  }

  reportProgress("Building table of contents...");
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

  reportProgress(`Indexed ${spine.length} chapters. Preparing reader...`);

  const chapters = spine.map((item, index) => buildChapterDescriptor(item, index, tocLookup));

  const title = metadata.title || file.name.replace(/\.epub$/i, "");
  const creator = metadata.creator || metadata.publisher || "";
  const chapterByPath = new Map(chapters.map((chapter) => [chapter.path, chapter]));
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));

  return {
    zip,
    objectUrlCache,
    title,
    creator,
    chapters,
    chapterByPath,
    chapterById,
    fileSize: formatBytes(file.size),
    cleanup() {
      objectUrlCache.forEach((url) => URL.revokeObjectURL(url));
      objectUrlCache.clear();
    },
  };
}

function buildChapterDescriptor(item, index, tocLookup) {
  const path = normalizeHrefPath(item.path);
  const tocTitle = tocLookup.get(path);

  return {
    id: `chapter-${index + 1}`,
    index,
    path,
    title: compactWhitespace(tocTitle || `Chapter ${index + 1}`),
    html: "",
    loadState: "idle",
    loadPromise: null,
  };
}

async function loadChapterContent(book, chapter) {
  if (!book || !chapter) {
    throw new Error("Missing chapter data.");
  }

  if (chapter.loadState === "ready" && chapter.html) {
    return chapter;
  }

  if (chapter.loadPromise) {
    return chapter.loadPromise;
  }

  chapter.loadState = "loading";
  chapter.loadPromise = (async () => {
    const rawMarkup = await readZipText(book.zip, chapter.path);
  const documentNode = new DOMParser().parseFromString(rawMarkup, "text/html");
  sanitizeChapterDocument(documentNode);
    await rewriteAssetUrls(documentNode, book.zip, book.objectUrlCache, chapter.path);
    await rewriteInlineStyles(documentNode, book.zip, book.objectUrlCache, chapter.path);

  const body = documentNode.body;
  if (!body) {
      throw new Error(`Could not parse chapter markup: ${chapter.path}`);
  }

    const discoveredTitle =
      pickHeading(body) ||
      documentNode.title?.trim() ||
      chapter.title ||
      `Chapter ${chapter.index + 1}`;

    if (isPlaceholderChapterTitle(chapter.title, chapter.index) || !chapter.title) {
      chapter.title = compactWhitespace(discoveredTitle);
    }
    chapter.html = body.innerHTML;
    chapter.loadState = "ready";
    chapter.loadPromise = null;
    syncRenderedTocTitle(chapter);
    return chapter;
  })().catch((error) => {
    chapter.loadState = "error";
    chapter.loadPromise = null;
    throw error;
  });

  return chapter.loadPromise;
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

function isPlaceholderChapterTitle(title, index) {
  return compactWhitespace(title || "") === `Chapter ${index + 1}`;
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
