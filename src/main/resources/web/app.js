"use strict";

const $ = (id) => document.getElementById(id);
const state = {
    deck: null,
    slide: null,
    node: null,
    data: null,
    serialized: "",
    request: 0,
    busy: false,
    // 修改指令草稿，按图片 ID 保存
    drafts: new Map(),
    // 已提交、等待完成后自动预览的任务
    watch: new Set(),
    textDirty: false,
    // 正在拖拽的页面；拖拽期间暂停自动刷新，避免列表被重绘打断
    dragging: null,
    // 正在从素材库拖出的素材 ID，与页面排序拖拽互斥
    libraryDrag: null,
    library: { open: false, all: [], items: [], tag: "", query: "", file: null },
    pendingSaves: 0,
    saving: Promise.resolve()
};
const statuses = {
    queued: "排队中",
    running: "处理中",
    succeeded: "已完成",
    failed: "失败"
};
let nameAction;
let toastTimer;

function element(tag, text, style) {
    const item = document.createElement(tag);
    if (text !== undefined) {
        item.textContent = text;
    }
    if (style) {
        item.className = style;
    }
    return item;
}

const icons = {
    settings: "M3 7h7m4 0h7M3 17h11m4 0h3M10 4v6m4 4v6",
    branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9",
    deck: "M3 4h18v12H3zM8 20h8M12 16v4",
    plus: "M12 5v14M5 12h14",
    palette: "M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8-.5-1-.1-2.2 1.1-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10ZM7.5 11.5h.01M10.5 7.5h.01M15.5 8.5h.01",
    download: "M12 3v12M7 10l5 5 5-5M5 21h14",
    trash: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
    close: "M6 6l12 12M18 6 6 18",
    up: "M12 19V5M6 11l6-6 6 6",
    down: "M12 5v14M6 13l6 6 6-6",
    insert: "M12 8v8M8 12h8M4 4h16v16H4z",
    rename: "M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4",
    edit: "M4 20h4L19 9l-4-4L4 16v4Z",
    sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z",
    upload: "M12 21V9M7 14l5-5 5 5M5 3h14",
    check: "M5 12l5 5 9-10",
    image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h.01",
    slides: "M3 5h18v12H3zM7 21h10",
    file: "M14 3H6v18h12V7l-4-4ZM14 3v4h4",
    retry: "M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5",
    restore: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
    home: "M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5",
    theme: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 3v18M12 8h5M12 12h7M12 16h5"
};
const themes = { light: "简洁", paper: "暖纸" };

function applyTheme(name, remember) {
    document.documentElement.dataset.theme = name;
    const next = name === "light" ? "paper" : "light";
    $("theme-label").textContent = themes[name];
    $("theme-button").title = "主题：" + themes[name] + "，点击切换为" + themes[next];
    $("theme-button").setAttribute("aria-label", $("theme-button").title);
    if (remember) {
        try {
            localStorage.setItem("slidebranch-theme", name);
        } catch {
            // 隐私模式等情况下无法保存，只影响本次会话
        }
    }
}

function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "i");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", icons[name]);
    svg.append(path);
    return svg;
}

function button(text, onClick, style, disabled = false, iconName) {
    const item = element("button", undefined, style);
    if (iconName) {
        item.append(icon(iconName));
    }
    if (text !== undefined) {
        item.append(element("span", text, "label"));
    }
    item.type = "button";
    item.disabled = disabled;
    item.onclick = onClick;
    return item;
}

function emptyIcon(name) {
    const box = element("span", undefined, "empty-icon");
    box.append(icon(name));
    return box;
}

function picture(node, style, lazy = false) {
    const image = element("img", undefined, style);
    image.src = "/api/nodes/" + node;
    image.alt = "";
    if (lazy) {
        image.loading = "lazy";
    }
    return image;
}

async function api(path, method = "GET", data) {
    const headers = {};
    let body;
    if (method !== "GET") {
        headers["X-SlideBranch"] = "1";
    }
    if (data instanceof File) {
        body = data;
    } else if (data !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(data);
    }
    const response = await fetch("/api" + path, { method, headers, body });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error || "操作失败");
    }
    return result;
}

function toast(message) {
    clearTimeout(toastTimer);
    const container = document.querySelector("dialog[open]") ?? document.body;
    container.append($("toast"));
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => {
        $("toast").hidden = true;
    }, 4800);
}

async function act(action) {
    if (state.busy) {
        return;
    }
    state.busy = true;
    try {
        await action();
        await refresh(true);
    } catch (error) {
        toast(error.message);
        // 例如页面要求已在别处更新（409），刷新后用户可以直接重新提交
        await refresh(true).catch(() => {});
    } finally {
        state.busy = false;
    }
}

function formatTime(value) {
    // SQLite 的 CURRENT_TIMESTAMP 是 UTC，形如 2026-11-20 08:30:00
    const date = new Date(String(value).replace(" ", "T") + "Z");
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function loadHome() {
    const result = await api("/decks");
    updateMode(result);
    if (state.deck !== null) {
        return;
    }
    const grid = $("deck-grid");
    grid.replaceChildren();
    $("deck-count").textContent = result.decks.length ? String(result.decks.length) : "";
    if (result.decks.length === 0) {
        const empty = element("div", undefined, "empty-content home-empty");
        empty.append(emptyIcon("deck"), element("h2", "还没有项目"),
            element("p", "点「新增项目」创建第一套演示稿。", "empty-summary"));
        grid.append(empty);
    }
    for (const deck of result.decks) {
        const card = element("div", undefined, "deck-card");
        const open = element("a", undefined, "deck-open");
        open.href = "#/deck/" + deck.id;
        if (deck.cover_node_id !== null) {
            open.append(picture(deck.cover_node_id, "thumb", true));
        } else {
            open.append(element("span", deck.slide_count ? "第一页未采用图片" : "空白项目", "thumb"));
        }
        const info = element("span", undefined, "deck-info");
        info.append(element("strong", deck.title),
            element("small", deck.slide_count + " 页 · 更新于 " + formatTime(deck.updated_at)));
        open.append(info);
        const remove = button(undefined, () => deleteDeck(deck), "icon danger deck-delete", false, "trash");
        remove.title = "删除项目";
        remove.setAttribute("aria-label", "删除项目「" + deck.title + "」");
        card.append(open, remove);
        grid.append(card);
    }
}

function deleteDeck(deck) {
    if (!window.confirm("删除项目「" + deck.title + "」？删除后不再显示在首页。")) {
        return;
    }
    void (async () => {
        try {
            await api("/decks/" + deck.id, "DELETE");
            toast("已删除「" + deck.title + "」");
        } catch (error) {
            toast(error.message);
        }
        await loadHome().catch((error) => toast(error.message));
    })();
}

function showView(name) {
    document.body.dataset.view = name;
    $("home").hidden = name !== "home";
    $("workspace").hidden = name !== "deck";
}

// 路由：#/ 为首页，#/deck/<id> 为项目工作台
function route() {
    const match = location.hash.match(/^#\/deck\/([1-9][0-9]*)$/);
    if (match) {
        showView("deck");
        openDeck(Number(match[1])).catch((error) => {
            toast(error.message);
            location.hash = "#/";
        });
        return;
    }
    showView("home");
    state.request++;
    state.deck = null;
    state.slide = null;
    state.data = null;
    state.serialized = "";
    render();
    document.title = "SlideBranch · 演示稿工作台";
    void loadHome().catch((error) => toast(error.message));
}

function updateMode(result) {
    const mode = $("mode");
    mode.textContent = result.model;
    mode.classList.toggle("demo", result.provider === "demo");
    mode.title = result.provider;
    if (result.provider === "demo") {
        mode.textContent = "本地演示";
        mode.title = "演示模式会生成占位图。可在本机设置中连接 RightAPI。";
    }
}

async function openDeck(id) {
    state.request++;
    state.deck = id;
    state.slide = null;
    state.node = null;
    state.data = null;
    state.serialized = "";
    render();
    // 先取素材名，候选图说明里要用
    await loadLibrary().catch(() => {});
    await refresh(true);
}

async function refresh(force = false) {
    if (state.deck === null) {
        return;
    }
    const request = ++state.request;
    const data = await api("/decks/" + state.deck);
    if (request !== state.request) {
        return;
    }
    const serialized = JSON.stringify(data);
    if (!force && serialized === state.serialized) {
        return;
    }
    const active = document.activeElement;
    const preservePrompt = active?.id === "instruction";
    let selectionStart;
    let selectionEnd;
    if (preservePrompt) {
        selectionStart = active.selectionStart;
        selectionEnd = active.selectionEnd;
    }
    state.data = data;
    state.serialized = serialized;
    followJobs(data);
    let slide = data.slides.find((item) => item.id === state.slide);
    if (!slide) {
        slide = data.slides[0];
        state.slide = slide?.id ?? null;
        state.node = null;
    }
    if (slide && !data.nodes.some((node) => node.slide_id === slide.id && node.id === state.node)) {
        state.node = defaultNode(slide);
    }
    render();
    if (preservePrompt && $("instruction")) {
        $("instruction").focus({ preventScroll: true });
        $("instruction").setSelectionRange(selectionStart, selectionEnd);
    }
}

function askName(heading, value, action) {
    nameAction = action;
    $("name-heading").textContent = heading;
    $("name-input").value = value;
    $("name-dialog").showModal();
    $("name-input").select();
}

function createDeck() {
    askName("新建演示稿", "", async (title) => {
        const result = await api("/decks", "POST", { title });
        location.hash = "#/deck/" + result.id;
    });
}

function addSlide(after = null) {
    const deck = state.deck;
    void act(async () => {
        await saveText();
        const result = await api("/decks/" + deck + "/slides", "POST", { after });
        state.slide = result.id;
        state.node = null;
    });
}

// 预览默认显示采用的图片；还没采用时显示最新的一张
function defaultNode(slide) {
    if (slide.selected_node_id !== null) {
        return slide.selected_node_id;
    }
    const nodes = state.data.nodes.filter((node) => node.slide_id === slide.id);
    return nodes.at(-1)?.id ?? null;
}

// 提交的任务完成后，预览自动切到新图片
function followJobs(data) {
    for (const id of state.watch) {
        const job = data.jobs.find((item) => item.id === id);
        if (!job || job.status === "failed") {
            state.watch.delete(id);
        } else if (job.status === "succeeded") {
            state.watch.delete(id);
            const node = data.nodes.find((item) => item.generation_job_id === id);
            if (node && node.slide_id === state.slide) {
                state.node = node.id;
            }
        }
    }
}

// 金额统一来自后端：estimated_cost_cents 为空表示失败、超时或未定价，需等供应商确认
function formatCost(cents, currency = "USD") {
    const symbol = currency === "USD" ? "$" : currency + " ";
    return symbol + (cents / 100).toFixed(2);
}

function jobCost(job) {
    if (["queued", "running"].includes(job.status) && job.unit_price_cents !== null) {
        return "预计 " + formatCost(job.unit_price_cents, job.currency);
    }
    if (job.estimated_cost_cents === null || job.billing_status !== "estimated") {
        return "费用待确认";
    }
    return "估算 " + formatCost(job.estimated_cost_cents, job.currency);
}

function renderDeckCost(costs) {
    const label = $("deck-cost");
    if (!costs) {
        label.textContent = "";
        label.title = "";
        return;
    }
    let text = "累计估算 " + formatCost(costs.estimated_cost_cents, costs.currency);
    const open = costs.pending_job_count + costs.unknown_job_count;
    if (open > 0) {
        text += " · " + open + " 项费用待确认";
    }
    label.textContent = text;
    label.title = "共 " + costs.job_count + " 次生成任务。金额为估算，失败和超时任务的实际费用以供应商为准。";
}

function libraryPath(withFilters) {
    const params = new URLSearchParams();
    if (withFilters && state.library.query) {
        params.set("q", state.library.query);
    }
    if (withFilters && state.library.tag) {
        params.set("tag", state.library.tag);
    }
    const text = params.toString();
    return "/library" + (text ? "?" + text : "");
}

// 标签筛选项来自完整列表；有筛选条件时再取一次筛选结果
async function loadLibrary() {
    const all = (await api(libraryPath(false))).items;
    let items = all;
    if (state.library.query || state.library.tag) {
        items = (await api(libraryPath(true))).items;
    }
    state.library.all = all;
    state.library.items = items;
    renderLibrary();
}

function setLibraryOpen(open) {
    state.library.open = open;
    $("library").hidden = !open;
    $("workspace").classList.toggle("library-open", open);
    $("library-button").setAttribute("aria-pressed", String(open));
    if (open) {
        void loadLibrary().catch((error) => toast(error.message));
    }
}

function renderLibrary() {
    const all = state.library.all;
    $("library-count").textContent = all.length ? String(all.length) : "";
    const tags = [...new Set(all.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    if (state.library.tag && !tags.includes(state.library.tag)) {
        tags.unshift(state.library.tag);
    }
    const filter = $("library-filter");
    filter.replaceChildren();
    filter.hidden = tags.length === 0;
    for (const tag of ["", ...tags]) {
        const chip = button(tag || "全部", () => {
            state.library.tag = tag;
            void loadLibrary().catch((error) => toast(error.message));
        }, "chip");
        chip.setAttribute("aria-pressed", String(state.library.tag === tag));
        filter.append(chip);
    }
    const list = $("library-list");
    list.replaceChildren();
    if (state.library.items.length === 0) {
        list.append(element("p", all.length ? "没有符合条件的素材。" : "还没有素材。点「上传」添加图片。", "muted gallery-empty"));
    }
    for (const item of state.library.items) {
        const card = element("div", undefined, "library-card");
        card.draggable = true;
        card.title = item.name + "（拖到左侧页面加入候选图）";
        const image = element("img", undefined, "thumb");
        image.src = "/api/library/" + item.id + "/image";
        image.alt = "";
        image.loading = "lazy";
        image.draggable = false;
        const info = element("div", undefined, "library-info");
        info.append(element("strong", item.name));
        if (item.tags.length) {
            const tagRow = element("span", undefined, "library-tags");
            for (const tag of item.tags) {
                tagRow.append(element("span", tag, "tag"));
            }
            info.append(tagRow);
        }
        const foot = element("span", undefined, "library-foot");
        // 不便拖拽时（键盘、触屏）可直接加入当前页
        foot.append(element("small", "拖入 " + item.usage_count + " 次", "muted"),
            button("加入当前页", () => addMaterial(state.slide, item), "ghost small", state.slide === null, "plus"));
        info.append(foot);
        card.append(image, info);
        card.ondragstart = (event) => {
            state.libraryDrag = item;
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("text/plain", item.name);
            requestAnimationFrame(() => card.classList.add("dragging"));
        };
        card.ondragend = () => {
            card.classList.remove("dragging");
            clearDropMarks();
            state.libraryDrag = null;
        };
        list.append(card);
    }
}

function addMaterial(slideId, item) {
    if (slideId === null || !state.data) {
        return;
    }
    const index = state.data.slides.findIndex((slide) => slide.id === slideId);
    void act(async () => {
        await saveText();
        await api("/slides/" + slideId + "/library", "POST", { item: item.id });
        toast("已把「" + item.name + "」加入第 " + (index + 1) + " 页的候选图");
        await loadLibrary().catch(() => {});
    });
}

function readTags(text) {
    return [...new Set(text.split(/[,，、;；\n]/).map((tag) => tag.trim()).filter(Boolean))];
}

function describe(node) {
    if (node.parent_id !== null) {
        return "由 #" + node.parent_id + " 修改：" + node.instruction;
    }
    if (node.library_item_id !== null) {
        const item = state.library.all.find((entry) => entry.id === node.library_item_id);
        return item ? "来自素材库：" + item.name : "来自素材库";
    }
    if (node.generation_job_id === null) {
        return "上传的图片";
    }
    return "根据页面文字生成";
}

function readText() {
    return {
        page_type: $("text-type").value,
        content: $("text-content").value,
        required_text: $("text-required").value,
        local_style: $("text-style").value
    };
}

// 保存页面文字。多次调用依次执行，生成、上传前先等待保存完成
function saveText() {
    const slide = Number($("text-form").dataset.slide);
    const fields = state.textDirty ? readText() : null;
    state.textDirty = false;
    state.pendingSaves++;
    const run = state.saving.catch(() => {}).then(async () => {
        try {
            if (fields && slide) {
                await api("/slides/" + slide + "/requirements", "POST", fields);
            }
        } catch (error) {
            if (Number($("text-form").dataset.slide) === slide) {
                state.textDirty = true;
            }
            throw error;
        } finally {
            state.pendingSaves--;
        }
    });
    state.saving = run;
    return run;
}

function selectSlide(slide) {
    void saveText().catch((error) => toast(error.message));
    state.slide = slide.id;
    state.node = defaultNode(slide);
    render();
}

function render() {
    const data = state.data;
    const slides = data?.slides ?? [];
    const index = slides.findIndex((slide) => slide.id === state.slide);
    const slide = slides[index];
    const nodes = data?.nodes.filter((node) => node.slide_id === slide?.id) ?? [];
    const jobs = data?.jobs.filter((job) => job.slide_id === slide?.id) ?? [];
    const viewed = nodes.find((node) => node.id === state.node);
    $("deck-title").textContent = data?.deck.title ?? "";
    $("deck-title").title = data?.deck.title ?? "";
    if (data) {
        document.title = data.deck.title + " · SlideBranch";
    }
    $("add-slide").disabled = !data;
    $("exports-button").disabled = !data;
    $("style-button").disabled = !data;
    $("trash-button").disabled = !data;
    $("slide-count").textContent = data ? String(slides.length) : "";
    renderTrash(data?.trash ?? []);
    renderSlides(slides);
    renderStage(slide, index, slides.length, viewed);
    renderText(slide);
    renderGallery(slide, nodes, jobs);
    renderExports(data?.exports ?? [], slides);
    renderDeckCost(data?.costs);
    $("library-button").disabled = !data;
}

function renderTrash(items) {
    $("trash-label").textContent = items.length ? "回收站 · " + items.length : "回收站";
    const list = $("trash-list");
    list.replaceChildren();
    if (items.length === 0) {
        list.append(element("p", "暂无已删除页面。", "muted"));
    }
    for (const slide of items) {
        const row = element("div", undefined, "trash-row");
        row.append(element("span", slide.title || "页面 #" + slide.id),
            button("恢复到末尾", () => act(() => api("/slides/" + slide.id + "/restore", "POST", {})), "", false, "restore"));
        list.append(row);
    }
}

function renderSlides(slides) {
    const list = $("slides");
    list.replaceChildren();
    for (const [index, slide] of slides.entries()) {
        // 用 div 承载拖拽：Firefox 不支持拖动 button 元素
        const card = element("div", undefined, "slide-card");
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.draggable = true;
        card.onclick = () => selectSlide(slide);
        card.onkeydown = (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                selectSlide(slide);
            }
        };
        if (slide.id === state.slide) {
            card.classList.add("active");
            card.setAttribute("aria-current", "true");
        }
        card.append(element("span", String(index + 1), "slide-index"));
        if (slide.selected_node_id !== null) {
            const thumb = picture(slide.selected_node_id, "thumb", true);
            thumb.draggable = false;
            card.append(thumb);
        } else if (state.data.nodes.some((node) => node.slide_id === slide.id)) {
            card.append(element("span", "未采用", "thumb"));
        } else {
            card.append(element("span", "空白页", "thumb"));
        }
        const caption = (slide.content || slide.required_text).split("\n")[0] || slide.page_type;
        card.append(element("small", caption));
        const materials = state.data.nodes.filter((node) => node.slide_id === slide.id && node.library_item_id !== null).length;
        if (materials > 0) {
            card.append(element("span", "素材 " + materials, "slide-materials"));
        }
        card.title = "第 " + (index + 1) + " 页 · " + caption + "（可拖动调整顺序，也可拖入素材）";
        bindDrag(card, slide, index);
        list.append(card);
    }
    if (state.data) {
        list.append(button("新建页", () => addSlide(), "add-slide-tile", false, "plus"));
    }
}

function clearDropMarks() {
    for (const item of document.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
        item.classList.remove("drop-before", "drop-after", "drop-into");
    }
}

// 竖排按上下半区、窄屏横排按左右半区，判断放到这页前面还是后面
function dropAfter(card, event) {
    const box = card.getBoundingClientRect();
    if (getComputedStyle(card.parentElement).flexDirection === "row") {
        return event.clientX > box.left + box.width / 2;
    }
    return event.clientY > box.top + box.height / 2;
}

function bindDrag(card, slide, index) {
    card.ondragstart = (event) => {
        state.dragging = { id: slide.id, index };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(slide.id));
        requestAnimationFrame(() => card.classList.add("dragging"));
    };
    card.ondragend = () => {
        card.classList.remove("dragging");
        clearDropMarks();
        state.dragging = null;
    };
    card.ondragover = (event) => {
        if (state.libraryDrag) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            if (!card.classList.contains("drop-into")) {
                clearDropMarks();
                card.classList.add("drop-into");
            }
            return;
        }
        if (!state.dragging) {
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const after = dropAfter(card, event);
        clearDropMarks();
        card.classList.add(after ? "drop-after" : "drop-before");
    };
    card.ondragleave = (event) => {
        if (!card.contains(event.relatedTarget)) {
            card.classList.remove("drop-before", "drop-after", "drop-into");
        }
    };
    card.ondrop = (event) => {
        event.preventDefault();
        const material = state.libraryDrag;
        const drag = state.dragging;
        clearDropMarks();
        if (material) {
            state.libraryDrag = null;
            addMaterial(slide.id, material);
            return;
        }
        if (!drag) {
            return;
        }
        // gap：放下位置之前有几页（0 到总页数）；换算成移除自身后的目标位置
        const gap = index + (dropAfter(card, event) ? 1 : 0);
        const position = gap > drag.index ? gap : gap + 1;
        state.dragging = null;
        if (position === drag.index + 1) {
            return;
        }
        void act(() => api("/slides/" + drag.id + "/move", "POST", { position }));
    };
}

function renderStage(slide, index, count, viewed) {
    const header = $("page-header");
    const preview = $("preview");
    const editor = $("editor");
    header.replaceChildren();
    preview.replaceChildren();
    editor.replaceChildren();
    preview.classList.toggle("empty", !viewed);
    if (!slide) {
        const empty = element("div", undefined, "empty-content");
        if (state.data) {
            empty.append(emptyIcon("slides"), element("h2", "新建第一页"),
                button("新建页", () => addSlide(), "primary", false, "plus"));
        } else {
            empty.append(element("p", "正在加载…", "muted"));
        }
        preview.append(empty);
        return;
    }
    const path = "/slides/" + slide.id;
    const toolbar = element("div", undefined, "toolbar");
    const up = button("上移", () => act(() => api(path + "/move", "POST", { direction: "up" })), "ghost", index === 0, "up");
    const down = button("下移", () => act(() => api(path + "/move", "POST", { direction: "down" })), "ghost", index === count - 1, "down");
    const insert = button("在后面新建页", () => addSlide(slide.id), "ghost", false, "insert");
    const remove = button("删除", () => {
        if (window.confirm("删除第 " + (index + 1) + " 页？可在回收站恢复。")) {
            void act(() => api(path, "DELETE"));
        }
    }, "ghost danger", false, "trash");
    for (const item of [up, down, insert, remove]) {
        item.title = item.textContent;
    }
    toolbar.append(up, down, element("span", undefined, "toolbar-sep"), insert,
        element("span", undefined, "toolbar-sep"), remove);
    const actions = element("div", undefined, "page-actions");
    actions.append(toolbar);
    const title = element("div", undefined, "page-title");
    title.append(element("span", (index + 1) + " / " + count, "page-number"), element("h1", "第 " + (index + 1) + " 页"));
    header.append(title, actions);
    if (!viewed) {
        const empty = element("div", undefined, "empty-content");
        empty.append(emptyIcon("image"), element("h2", "还没有图片"),
            element("p", "在右侧写下这页的文字，点「生成图片」，或上传一张图片。", "empty-summary"));
        preview.append(empty);
        return;
    }
    const image = picture(viewed.id);
    image.alt = "第 " + (index + 1) + " 页的图片 #" + viewed.id;
    preview.append(image);
    renderEditor(editor, slide, viewed);
}

function renderEditor(editor, slide, viewed) {
    const path = "/slides/" + slide.id;
    const bar = element("div", undefined, "preview-bar");
    const caption = element("span", "#" + viewed.id + " · " + describe(viewed), "lineage");
    caption.title = caption.textContent;
    const adopted = slide.selected_node_id === viewed.id;
    const adopt = button(adopted ? "已采用" : "采用这张", () => act(() => api(path + "/select", "POST", { node: viewed.id })),
        adopted ? "adopted" : "", adopted, "check");
    adopt.title = "导出时使用这张图片";
    bar.append(caption);
    const job = state.data.jobs.find((item) => item.id === viewed.generation_job_id);
    if (job) {
        const cost = element("span", job.model + " · " + jobCost(job), "job-cost");
        cost.title = "模型 " + job.model + "，" + jobCost(job);
        bar.append(cost);
    }
    bar.append(adopt);

    const key = String(viewed.id);
    const form = element("form", undefined, "edit-form");
    const label = element("label");
    label.append(icon("edit"), element("span", "修改这张图"));
    label.htmlFor = "instruction";
    const prompt = element("textarea");
    prompt.id = "instruction";
    prompt.maxLength = 4000;
    prompt.placeholder = "说明要改什么，例如：标题改成「2026 年度回顾」，其余不变";
    prompt.value = state.drafts.get(key) ?? "";
    prompt.oninput = () => {
        state.drafts.set(key, prompt.value);
    };
    prompt.onkeydown = (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            form.requestSubmit();
        }
    };
    const head = element("div", undefined, "edit-head");
    head.append(label);
    const controls = element("div", undefined, "editor-actions");
    const hint = element("span", undefined, "hint");
    hint.append(element("kbd", "Ctrl"), " + ", element("kbd", "Enter"));
    const submit = element("button", undefined, "primary");
    submit.type = "submit";
    submit.append(icon("branch"), element("span", "修改"));
    controls.append(hint, submit);
    form.append(head, prompt, controls);
    form.onsubmit = (event) => {
        event.preventDefault();
        const instruction = prompt.value.trim();
        if (!instruction) {
            toast("写下要修改的内容");
            prompt.focus();
            return;
        }
        void act(async () => {
            await saveText();
            const result = await api(path + "/generate", "POST", { parent: viewed.id, instruction });
            state.watch.add(result.id);
            state.drafts.delete(key);
        });
    };
    editor.append(bar, form);
}

function renderText(slide) {
    $("text-card").hidden = !slide;
    if (!slide) {
        return;
    }
    // 页面要求在别处更新时同步到表单；本地有未保存或保存中的文字时不覆盖
    const form = $("text-form");
    const changedSlide = Number(form.dataset.slide) !== slide.id;
    const revision = slide.requirements_revision;
    if (changedSlide || (!state.textDirty && state.pendingSaves === 0 && Number(form.dataset.revision) !== revision)) {
        form.dataset.slide = slide.id;
        form.dataset.revision = revision;
        $("text-type").value = slide.page_type;
        $("text-content").value = slide.content;
        $("text-required").value = slide.required_text;
        $("text-style").value = slide.local_style;
        state.textDirty = false;
    }
    const style = state.data.deck.style;
    $("deck-style-link").textContent = style ? "项目风格：" + style : "设置项目风格";
    $("deck-style-link").title = "所有页面共用的风格，点击修改";
}

function renderGallery(slide, nodes, jobs) {
    const list = $("gallery");
    list.replaceChildren();
    $("version-count").textContent = nodes.length ? String(nodes.length) : "";
    $("upload-button").disabled = !slide;
    if (!slide) {
        return;
    }
    const working = (job) => ["queued", "running"].includes(job.status);
    // 失败的任务只在之后没有新任务时显示，避免堆积
    const lastOther = Math.max(0, ...jobs.filter((job) => job.status !== "failed").map((job) => job.id));
    for (const job of jobs.filter((item) => working(item) || (item.status === "failed" && item.id > lastOther))) {
        const tile = element("div", undefined, "tile placeholder");
        const box = element("div", undefined, "tile-box");
        if (job.status === "failed") {
            tile.classList.add("is-failed");
            const message = element("span", job.error_message || "生成失败", "failed");
            message.title = message.textContent;
            box.append(message, button("重试", () => act(async () => {
                const result = await api("/slides/" + slide.id + "/retry", "POST", { job: job.id });
                state.watch.add(result.id);
            }), "", false, "retry"));
        } else {
            box.append(element("span", job.parent_node_id === null ? "生成中" : "修改中", "status running"));
        }
        tile.title = job.instruction + "\n" + job.model + " · " + jobCost(job);
        tile.append(box, element("span", job.parent_node_id === null ? "新图片" : "修改 #" + job.parent_node_id, "tile-label"),
            element("span", job.model + " · " + jobCost(job), "tile-label tile-cost"));
        list.append(tile);
    }
    for (const node of nodes.toReversed()) {
        const tile = button(undefined, () => {
            state.node = node.id;
            render();
        }, "tile");
        tile.title = "#" + node.id + " · " + describe(node);
        tile.setAttribute("aria-label", tile.title);
        if (node.id === state.node) {
            tile.classList.add("current");
            tile.setAttribute("aria-current", "true");
        }
        const box = element("span", undefined, "tile-box");
        box.append(picture(node.id, "", true));
        if (node.id === slide.selected_node_id) {
            const badge = element("span", undefined, "badge");
            badge.append(icon("check"), "采用");
            box.append(badge);
        }
        if (node.library_item_id !== null) {
            box.append(element("span", "素材库", "source-badge"));
        }
        tile.append(box, element("span", "#" + node.id, "tile-label"));
        list.append(tile);
    }
    if (list.childElementCount === 0) {
        list.append(element("p", "生成或上传的图片都保存在这里。", "muted gallery-empty"));
    }
}

function renderExports(exports, slides) {
    const list = $("export-list");
    list.replaceChildren();
    const missing = slides.flatMap((slide, index) => slide.selected_node_id === null ? [index + 1] : []);
    const disabled = slides.length === 0 || missing.length > 0;
    $("export-pptx").disabled = disabled;
    $("export-pdf").disabled = disabled;
    if (slides.length === 0) {
        list.append(element("p", "新建页面并为每页采用一张图片后即可导出。", "muted"));
    } else if (missing.length > 0) {
        list.append(element("p", "第 " + missing.join("、") + " 页还没有采用图片。", "muted"));
    } else if (exports.length === 0) {
        list.append(element("p", "暂无导出记录。", "muted"));
    }
    for (const item of exports) {
        const row = element("div", undefined, "export-row");
        row.append(element("span", item.format.toUpperCase(), "export-name"),
            element("span", item.slide_count + " 页", "muted"),
            element("span", statuses[item.status], "status " + item.status));
        if (item.status === "succeeded") {
            const link = element("a");
            link.append(icon("download"), "下载");
            link.href = "/api/exports/" + item.id;
            row.append(link);
        }
        if (item.error_message) {
            row.append(element("p", item.error_message, "failed"));
        }
        list.append(row);
    }
}

for (const slot of document.querySelectorAll("[data-icon]")) {
    slot.replaceChildren(icon(slot.dataset.icon));
}
applyTheme(document.documentElement.dataset.theme in themes ? document.documentElement.dataset.theme : "light", false);
$("theme-button").onclick = () => {
    applyTheme(document.documentElement.dataset.theme === "paper" ? "light" : "paper", true);
};
const openSettings = async () => {
    try {
        const settings = await api("/settings");
        $("settings-form").reset();
        $("settings-key").disabled = false;
        $("settings-model").value = settings.model;
        $("settings-size").value = settings.size;
        $("settings-remove-row").hidden = !settings.savedKey;
        let hint = "输入密钥后，将使用当前 Windows 账户加密保存。";
        if (settings.savedKey) {
            hint = "已在本机保存，留空可保留原密钥。";
            if (settings.environmentKey) {
                hint += "移除后会使用环境变量中的密钥。";
            }
        } else if (settings.environmentKey) {
            hint = "正在使用环境变量中的密钥。填写后优先使用本机设置。";
        }
        $("settings-key-state").textContent = hint;
        $("settings-dialog").showModal();
    } catch (error) {
        toast(error.message);
    }
};
$("settings-button").onclick = openSettings;
$("home-settings").onclick = openSettings;
$("settings-remove").onchange = () => {
    $("settings-key").disabled = $("settings-remove").checked;
    $("settings-key").value = "";
};
$("settings-dialog").onclose = () => {
    $("settings-key").value = "";
};
$("settings-form").onsubmit = (event) => {
    event.preventDefault();
    void act(async () => {
        const result = await api("/settings", "POST", {
            key: $("settings-key").value,
            model: $("settings-model").value,
            size: $("settings-size").value,
            removeKey: $("settings-remove").checked
        });
        updateMode(result);
        $("settings-dialog").close();
        toast("绘图设置已保存");
    });
};
$("home-new").onclick = createDeck;
$("text-form").oninput = () => {
    state.textDirty = true;
};
// 页面文字在离开输入区时自动保存
$("text-form").addEventListener("focusout", (event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
        void saveText().catch((error) => toast(error.message));
    }
});
$("text-form").onsubmit = (event) => {
    event.preventDefault();
    const text = readText();
    if (!text.content.trim() && !text.required_text.trim()) {
        toast("先写下这页的内容");
        $("text-content").focus();
        return;
    }
    const slide = state.slide;
    void act(async () => {
        await saveText();
        const result = await api("/slides/" + slide + "/generate", "POST", { parent: null, instruction: "" });
        state.watch.add(result.id);
    });
};
$("upload-button").onclick = () => $("upload-input").click();
$("upload-input").onchange = () => {
    const file = $("upload-input").files[0];
    $("upload-input").value = "";
    const slide = state.slide;
    if (file && slide !== null) {
        void act(async () => {
            await saveText();
            const result = await api("/slides/" + slide + "/upload", "POST", file);
            state.node = result.id;
        });
    }
};
const openStyle = () => {
    $("deck-style").value = state.data.deck.style;
    $("style-dialog").showModal();
};
$("style-button").onclick = openStyle;
$("deck-style-link").onclick = openStyle;
$("style-form").onsubmit = (event) => {
    event.preventDefault();
    void act(async () => {
        await api("/decks/" + state.deck + "/style", "POST", { style: $("deck-style").value });
        $("style-dialog").close();
    });
};
$("trash-button").onclick = () => $("trash-dialog").showModal();
$("library-button").onclick = () => setLibraryOpen(!state.library.open);
$("library-close").onclick = () => setLibraryOpen(false);
$("library-add").onclick = () => $("library-input").click();
$("library-input").onchange = () => {
    const file = $("library-input").files[0];
    $("library-input").value = "";
    if (!file) {
        return;
    }
    state.library.file = file;
    $("library-file").textContent = file.name;
    $("library-name").value = file.name.replace(/\.[^.]+$/, "").slice(0, 100) || "未命名素材";
    $("library-tags").value = state.library.tag;
    $("library-upload").hidden = false;
    $("library-name").select();
};
$("library-cancel").onclick = () => {
    state.library.file = null;
    $("library-upload").hidden = true;
};
$("library-upload").onsubmit = (event) => {
    event.preventDefault();
    const file = state.library.file;
    const tags = readTags($("library-tags").value);
    if (!file) {
        return;
    }
    if (tags.length > 20 || tags.some((tag) => tag.length > 40)) {
        toast("最多 20 个标签，每个标签不超过 40 个字符");
        return;
    }
    const params = new URLSearchParams({ name: $("library-name").value.trim() });
    for (const tag of tags) {
        params.append("tag", tag);
    }
    void act(async () => {
        await api("/library/upload?" + params, "POST", file);
        state.library.file = null;
        $("library-upload").hidden = true;
        toast("素材已上传");
        await loadLibrary();
    });
};
let searchTimer;
$("library-search").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        state.library.query = $("library-search").value.trim();
        void loadLibrary().catch((error) => toast(error.message));
    }, 250);
};
$("add-slide").onclick = () => addSlide();
window.addEventListener("hashchange", () => {
    if ($("text-form").dataset.slide) {
        void saveText().catch((error) => toast(error.message));
    }
    route();
});
$("name-form").onsubmit = (event) => {
    event.preventDefault();
    const action = nameAction;
    const title = $("name-input").value;
    void act(async () => {
        await action(title);
        $("name-dialog").close();
    });
};
$("exports-button").onclick = () => {
    $("exports-dialog").showModal();
};
for (const format of ["pptx", "pdf"]) {
    $("export-" + format).onclick = () => act(() => api("/decks/" + state.deck + "/exports", "POST", { format }));
}
for (const item of document.querySelectorAll("[data-close]")) {
    item.onclick = () => $(item.dataset.close).close();
}
window.addEventListener("beforeunload", (event) => {
    if (state.textDirty || state.pendingSaves > 0) {
        void saveText().catch(() => {});
        event.preventDefault();
    }
});

if (!location.hash.startsWith("#/deck/")) {
    history.replaceState(null, "", "#/");
} else {
    // 直接打开项目链接时不经过首页，单独取一次绘图模式
    void api("/decks").then(updateMode).catch(() => {});
}
route();
let lastPoll = 0;
setInterval(() => {
    if (state.busy || state.dragging || state.libraryDrag || !state.data || document.hidden) {
        return;
    }
    const pending = (item) => ["queued", "running"].includes(item.status);
    const working = state.data.jobs.some(pending) || state.data.exports.some(pending);
    if (!working && Date.now() - lastPoll < 15000) {
        return;
    }
    lastPoll = Date.now();
    void refresh().catch(() => {});
}, 1400);
