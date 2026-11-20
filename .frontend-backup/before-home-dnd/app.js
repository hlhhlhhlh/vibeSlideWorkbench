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
    // 每页当前要求的 ID，保存文字后更新
    boards: new Map(),
    textDirty: false,
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

async function api(path, method = "GET", data, boardId) {
    const headers = {};
    if (boardId !== undefined) {
        headers["X-Board-Id"] = String(boardId);
    }
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

async function loadDecks(preferred) {
    const result = await api("/decks");
    const list = $("deck-list");
    list.replaceChildren();
    for (const deck of result.decks) {
        const option = element("option", deck.title);
        option.value = deck.id;
        list.append(option);
    }
    list.disabled = result.decks.length === 0;
    let id = preferred;
    if (!result.decks.some((deck) => deck.id === preferred)) {
        id = result.decks[0]?.id ?? null;
    }
    if (id === null) {
        list.append(element("option", "暂无演示稿"));
    } else {
        list.value = id;
    }
    updateMode(result);
    await openDeck(id);
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
        await loadDecks(result.id);
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

function describe(node) {
    if (node.parent_id !== null) {
        return "由 #" + node.parent_id + " 修改：" + node.instruction;
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

// 保存页面文字。多次调用依次执行，返回该页当前的要求 ID
function saveText() {
    const slide = Number($("text-form").dataset.slide);
    const fields = state.textDirty ? readText() : null;
    state.textDirty = false;
    state.pendingSaves++;
    const run = state.saving.catch(() => {}).then(async () => {
        try {
            if (!fields) {
                return state.boards.get(slide);
            }
            const result = await api("/slides/" + slide + "/board", "POST", { board: state.boards.get(slide), ...fields });
            state.boards.set(slide, result.id);
            return result.id;
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
        const card = button(undefined, () => selectSlide(slide), "slide-card");
        if (slide.id === state.slide) {
            card.classList.add("active");
            card.setAttribute("aria-current", "true");
        }
        card.append(element("span", String(index + 1), "slide-index"));
        if (slide.selected_node_id !== null) {
            card.append(picture(slide.selected_node_id, "thumb", true));
        } else if (state.data.nodes.some((node) => node.slide_id === slide.id)) {
            card.append(element("span", "未采用", "thumb"));
        } else {
            card.append(element("span", "空白页", "thumb"));
        }
        const caption = (slide.content || slide.required_text).split("\n")[0] || slide.page_type;
        card.append(element("small", caption));
        card.title = "第 " + (index + 1) + " 页 · " + caption;
        list.append(card);
    }
    if (state.data) {
        list.append(button("新建页", () => addSlide(), "add-slide-tile", false, "plus"));
    }
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
        if (state.deck === null) {
            empty.append(emptyIcon("deck"), element("h2", "创建你的第一套演示稿"),
                element("p", "每页一张整图。写下文字生成图片，再用一句话修改。", "empty-summary"),
                button("新建演示稿", createDeck, "primary", false, "plus"));
        } else if (state.data) {
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
    bar.append(caption, adopt);

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
            const board = await saveText();
            const result = await api(path + "/generate", "POST", { board, parent: viewed.id, instruction });
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
    // 要求 ID 只增不减；刚保存、尚未刷新时，以本地记录的较新 ID 为准
    state.boards.set(slide.id, Math.max(state.boards.get(slide.id) ?? 0, slide.board_id));
    const form = $("text-form");
    const changedSlide = Number(form.dataset.slide) !== slide.id;
    if (changedSlide || (!state.textDirty && Number(form.dataset.board) !== slide.board_id)) {
        form.dataset.slide = slide.id;
        form.dataset.board = slide.board_id;
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
        tile.title = job.instruction;
        tile.append(box, element("span", job.parent_node_id === null ? "新图片" : "修改 #" + job.parent_node_id, "tile-label"));
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
$("settings-button").onclick = async () => {
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
$("create-deck").onclick = createDeck;
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
        const board = await saveText();
        const result = await api("/slides/" + slide + "/generate", "POST", { board, parent: null, instruction: "" });
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
            const board = await saveText();
            const result = await api("/slides/" + slide + "/upload", "POST", file, board);
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
$("add-slide").onclick = () => addSlide();
$("deck-list").onchange = () => {
    void saveText().catch((error) => toast(error.message));
    void act(() => openDeck(Number($("deck-list").value)));
};
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

void loadDecks(null).catch((error) => toast(error.message));
let lastPoll = 0;
setInterval(() => {
    if (state.busy || !state.data || document.hidden) {
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
