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
    drafts: new Map()
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
    let slide = data.slides.find((item) => item.id === state.slide);
    if (!slide) {
        slide = data.slides[0];
        state.slide = slide?.id ?? null;
        state.node = null;
    }
    if (slide && !data.nodes.some((node) => node.slide_id === slide.id && node.id === state.node)) {
        state.node = slide.selected_node_id;
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
    askName("添加页面", "", async (title) => {
        const result = await api("/decks/" + deck + "/slides", "POST", { title, after });
        state.slide = result.id;
        state.node = null;
    });
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
    renderBoard(slide, nodes.length > 0 || jobs.some((job) => ["queued","running"].includes(job.status)));
    renderTrash(data?.trash ?? []);
    const previewState = $("preview-state");
    previewState.textContent = "";
    previewState.classList.toggle("selected", Boolean(viewed) && viewed.id === slide.selected_node_id);
    if (viewed) {
        previewState.textContent = "版本 #" + viewed.id;
        if (viewed.id === slide.selected_node_id) {
            previewState.textContent += " · 本页选图";
        }
    }
    $("slide-count").textContent = data ? String(slides.length) : "";
    $("version-count").textContent = nodes.length ? String(nodes.length) : "";
    renderSlides(slides);
    renderStage(slide, index, slides.length, viewed, jobs);
    renderVersions(nodes, slide);
    renderJobs(jobs);
    renderExports(data?.exports ?? [], slides);
}

function renderBoard(slide, hasTree) {
    const card = $("board-card");
    card.replaceChildren();
    card.hidden = !slide;
    if (!slide) {
        return;
    }
    const header = element("div", undefined, "panel-header");
    header.append(element("h2","页面底板"),button("编辑", () => {
        const form = $("board-form");
        form.dataset.slide = slide.id;
        form.dataset.board = slide.board_id;
        $("page-type").value = slide.page_type;
        $("board-content").value = slide.content;
        $("board-text").value = slide.required_text;
        $("board-style").value = slide.local_style;
        $("board-notice").textContent = "保存后可按底板生成原图。";
        $("board-notice").classList.toggle("warn", hasTree);
        if (hasTree) {
            $("board-notice").textContent = "改动底板会开始一棵新树，并清空本页选图。已有导出保留原图。";
        }
        $("board-dialog").showModal();
    }, "ghost", false, "edit"));
    card.append(header, element("span",slide.page_type,"type-chip"));
    const fields = element("dl",undefined,"board-fields");
    for (const [name,value] of [
        ["内容要求",slide.content],
        ["必须出现的文字",slide.required_text],
        ["本页风格",slide.local_style],
        ["项目风格",state.data.deck.style]
    ]) {
        const description = element("dd",value || "未填写");
        if (!value) {
            description.classList.add("unset");
        } else if (name === "项目风格") {
            description.classList.add("inherited");
        }
        fields.append(element("dt",name),description);
    }
    card.append(fields);
}

function renderTrash(items) {
    $("trash-label").textContent = items.length ? "回收站 · " + items.length : "回收站";
    const list = $("trash-list");
    list.replaceChildren();
    if (items.length === 0) {
        list.append(element("p","暂无已删除页面。","muted"));
    }
    for (const slide of items) {
        const row = element("div",undefined,"trash-row");
        row.append(element("span",slide.title),button("恢复到末尾",() => act(() => api("/slides/" + slide.id + "/restore","POST",{})),"",false,"restore"));
        list.append(row);
    }
}

function renderSlides(slides) {
    const list = $("slides");
    list.replaceChildren();
    for (const [index, slide] of slides.entries()) {
        const card = button(undefined, () => {
            state.slide = slide.id;
            state.node = slide.selected_node_id;
            render();
        }, "slide-card");
        if (slide.id === state.slide) {
            card.classList.add("active");
            card.setAttribute("aria-current", "true");
        }
        card.append(element("span", String(index + 1), "slide-index"));
        if (slide.selected_node_id !== null) {
            card.append(picture(slide.selected_node_id, "thumb", true));
        } else {
            card.append(element("span", "待生成", "thumb"));
        }
        card.append(element("small", slide.title));
        card.title = slide.title;
        list.append(card);
    }
    if (state.data) {
        list.append(button("添加页面", () => addSlide(), "add-slide-tile", false, "plus"));
    }
}

function renderStage(slide, index, count, viewed, jobs) {
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
                element("p", "每页一张整图，随时从任意版本继续修改。", "empty-summary"),
                button("新建演示稿", createDeck, "primary", false, "plus"));
        } else if (state.data) {
            empty.append(emptyIcon("slides"), element("h2", "添加第一页"),
                button("添加页面", () => addSlide(), "primary", false, "plus"));
        } else {
            empty.append(element("p", "正在加载…", "muted"));
        }
        preview.append(empty);
        return;
    }
    const path = "/slides/" + slide.id;
    const actions = element("div", undefined, "page-actions");
    const toolbar = element("div", undefined, "toolbar");
    const up = button("上移", () => act(() => api(path + "/move", "POST", { direction: "up" })), "ghost", index === 0, "up");
    const down = button("下移", () => act(() => api(path + "/move", "POST", { direction: "down" })), "ghost", index === count - 1, "down");
    const insert = button("插入下一页", () => addSlide(slide.id), "ghost", false, "insert");
    const rename = button("改名", () => askName("修改页面名称", slide.title, (title) => api(path + "/rename", "POST", { title })), "ghost", false, "rename");
    const remove = button("删除", () => {
        if (window.confirm("删除「" + slide.title + "」？已有的导出文件仍可下载。")) {
            void act(() => api(path, "DELETE"));
        }
    }, "ghost danger", false, "trash");
    for (const item of [up, down, insert, rename, remove]) {
        item.title = item.textContent;
    }
    toolbar.append(up, down, element("span", undefined, "toolbar-sep"), insert, rename,
        element("span", undefined, "toolbar-sep"), remove);
    actions.append(toolbar);
    const title = element("div", undefined, "page-title");
    title.append(element("span", (index + 1) + " / " + count, "page-number"), element("h1", slide.title));
    header.append(title, actions);
    if (viewed) {
        const image = picture(viewed.id);
        image.alt = slide.title + "的图片版本 " + viewed.id;
        preview.append(image);
    } else {
        const empty = element("div", undefined, "empty-content");
        empty.append(emptyIcon("image"), element("span", slide.page_type, "type-chip"), element("h2", slide.title),
            element("p", slide.content || "填写页面底板，然后生成或上传原图。", "empty-summary"));
        preview.append(empty);
    }
    const rootPending = jobs.some((job) => job.parent_node_id === null && ["queued", "running"].includes(job.status));
    renderEditor(editor, slide, viewed, rootPending);
}

function renderEditor(editor, slide, viewed, rootPending) {
    const path = "/slides/" + slide.id;
    const parent = viewed?.id ?? null;
    const key = slide.board_id + "/" + parent;
    const form = element("form", undefined, "edit-form");
    const label = element("label");
    label.append(icon("sparkle"), element("span", viewed ? "基于版本 #" + viewed.id + " 修改" : "原图补充要求（可选）"));
    label.htmlFor = "instruction";
    const prompt = element("textarea");
    prompt.id = "instruction";
    prompt.maxLength = 4000;
    prompt.required = Boolean(viewed);
    prompt.placeholder = "例如：16:9，深绿色背景，标题为「产品发布」";
    if (viewed) {
        prompt.placeholder = "例如：把右侧插图换成机器臂，保留现有文字和排版";
    }
    prompt.value = state.drafts.get(key) ?? "";
    prompt.disabled = rootPending && !viewed;
    prompt.oninput = () => {
        state.drafts.set(key, prompt.value);
    };
    const controls = element("div", undefined, "editor-actions");
    const submit = element("button", undefined, "primary");
    const submitLabel = element("span", "生成原图");
    submit.append(icon(viewed ? "branch" : "sparkle"), submitLabel);
    submit.type = "submit";
    if (viewed) {
        submitLabel.textContent = "生成新分支";
        const isSelected = slide.selected_node_id === parent;
        controls.append(button(isSelected ? "已是本页选图" : "设为本页选图",
            () => act(() => api(path + "/select", "POST", { node: parent })), "", isSelected, "check"));
    } else {
        submit.disabled = rootPending;
        if (rootPending) {
            submitLabel.textContent = "原图生成中";
        }
        const upload = element("input");
        upload.type = "file";
        upload.accept = "image/png,image/jpeg";
        upload.hidden = true;
        upload.onchange = () => {
            const file = upload.files[0];
            if (file) {
                void act(() => api(path + "/upload", "POST", file, slide.board_id));
            }
            upload.value = "";
        };
        controls.append(upload, button("上传原图", () => upload.click(), "", rootPending, "upload"));
    }
    const hint = element("span", undefined, "hint");
    hint.append(element("kbd", "Ctrl"), " + ", element("kbd", "Enter"), " 提交");
    controls.append(hint, submit);
    const head = element("div", undefined, "edit-head");
    head.append(label);
    if (viewed?.parent_id != null) {
        const lineage = element("span", "来自 #" + viewed.parent_id + " · " + viewed.instruction, "lineage");
        lineage.title = lineage.textContent;
        head.append(lineage);
    }
    prompt.onkeydown = (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !submit.disabled) {
            event.preventDefault();
            form.requestSubmit();
        }
    };
    form.append(head, prompt, controls);
    form.onsubmit = (event) => {
        event.preventDefault();
        void act(async () => {
            await api(path + "/generate", "POST", { board: slide.board_id, parent, instruction: prompt.value });
            state.drafts.delete(key);
            toast("已提交生成任务");
        });
    };
    editor.append(form);
}

function renderVersions(nodes, slide) {
    const list = $("versions");
    list.replaceChildren();
    if (nodes.length === 0) {
        list.append(element("p", "生成或上传原图后，版本将显示在这里。", "muted tree-empty"));
        return;
    }
    const children = new Map();
    for (const node of nodes) {
        if (!children.has(node.parent_id)) {
            children.set(node.parent_id, []);
        }
        children.get(node.parent_id).push(node);
    }
    const queue = children.get(null).map((node) => ({ node, depth: 0 }));
    while (queue.length > 0) {
        const { node, depth } = queue.pop();
        let label = "原图";
        if (node.parent_id !== null) {
            label = node.instruction;
        }
        const item = button(undefined, () => {
            state.node = node.id;
            render();
        }, "tree-row");
        item.style.setProperty("--depth", String(Math.min(depth, 6)));
        if (depth > 0) {
            item.classList.add("child");
        }
        item.title = "#" + node.id + " · " + (node.instruction ?? label);
        item.setAttribute("aria-label", item.title);
        if (node.id === state.node) {
            item.classList.add("current");
            item.setAttribute("aria-current", "true");
        }
        const text = element("span", undefined, "tree-text");
        text.append(element("strong", "#" + node.id), element("span", label));
        item.append(picture(node.id, "", true), text);
        if (node.id === slide.selected_node_id) {
            const badge = element("span", undefined, "badge");
            badge.append(icon("check"), "已选");
            item.append(badge);
        }
        list.append(item);
        const descendants = children.get(node.id) ?? [];
        for (let index = descendants.length - 1; index >= 0; index--) {
            queue.push({ node: descendants[index], depth: depth + 1 });
        }
    }
}

function renderJobs(jobs) {
    const list = $("jobs");
    list.replaceChildren();
    list.hidden = jobs.length === 0;
    if (list.hidden) {
        return;
    }
    const heading = element("div", undefined, "panel-header");
    heading.append(element("h2", "最近的生成任务"));
    list.append(heading);
    for (const job of jobs.slice(0, 10)) {
        const row = element("div", undefined, "job");
        let source = "原图";
        if (job.parent_node_id !== null) {
            source = "基于 #" + job.parent_node_id;
        }
        const head = element("div", undefined, "job-head");
        head.append(element("span", statuses[job.status], "status " + job.status), element("span", source));
        row.append(head);
        if (job.parent_node_id === null) {
            const details = element("details",undefined,"job-details");
            details.append(element("summary","查看原图要求"), element("p",job.instruction,"muted"));
            row.append(details);
        } else {
            row.append(element("p",job.instruction,"muted"));
        }
        if (job.error_message) {
            row.append(element("p", job.error_message, "failed"));
            row.append(button("重试", () => act(() => api("/slides/" + job.slide_id + "/retry", "POST", { job: job.id })), "", false, "retry"));
        }
        list.append(row);
    }
}

function renderExports(exports, slides) {
    const list = $("export-list");
    list.replaceChildren();
    const disabled = slides.length === 0 || slides.some((slide) => slide.selected_node_id === null);
    $("export-pptx").disabled = disabled;
    $("export-pdf").disabled = disabled;
    if (disabled) {
        list.append(element("p", "添加页面并为每页选图后即可导出。", "muted"));
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
$("board-form").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    void act(async () => {
        await api("/slides/" + form.dataset.slide + "/board","POST",{
            board: Number(form.dataset.board),
            page_type: $("page-type").value,
            content: $("board-content").value,
            required_text: $("board-text").value,
            local_style: $("board-style").value
        });
        $("board-dialog").close();
        toast("底板已保存");
    });
};
$("style-button").onclick = () => {
    $("deck-style").value = state.data.deck.style;
    $("style-dialog").showModal();
};
$("style-form").onsubmit = (event) => {
    event.preventDefault();
    void act(async () => {
        await api("/decks/" + state.deck + "/style","POST",{style: $("deck-style").value});
        $("style-dialog").close();
    });
};
$("trash-button").onclick = () => $("trash-dialog").showModal();
$("add-slide").onclick = () => addSlide();
$("deck-list").onchange = () => {
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

void loadDecks(null).catch((error) => toast(error.message));
let lastPoll = 0;
setInterval(() => {
    if (state.busy || !state.data || document.hidden) {
        return;
    }
    const pending = (item) => ["queued","running"].includes(item.status);
    const working = state.data.jobs.some(pending) || state.data.exports.some(pending);
    if (!working && Date.now() - lastPoll < 15000) {
        return;
    }
    lastPoll = Date.now();
    void refresh().catch(() => {});
}, 1400);
