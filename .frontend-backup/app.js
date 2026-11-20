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

function button(text, onClick, style, disabled = false) {
    const item = element("button", text, style);
    item.type = "button";
    item.disabled = disabled;
    item.onclick = onClick;
    return item;
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
    const mode = $("mode");
    mode.textContent = result.model;
    if (result.provider === "demo") {
        mode.textContent = "本地演示";
        mode.title = "演示模式会生成占位图。配置 IMAGE_API_KEY 后可调用图像模型。";
    }
    await openDeck(id);
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
    $("preview-state").textContent = "";
    if (viewed) {
        $("preview-state").textContent = "版本 #" + viewed.id;
        if (viewed.id === slide.selected_node_id) {
            $("preview-state").textContent += " · 本页选图";
        }
    }
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
    const header = element("div", undefined, "section-header");
    header.append(element("h2","页面底板"),button("编辑", () => {
        const form = $("board-form");
        form.dataset.slide = slide.id;
        form.dataset.board = slide.board_id;
        $("page-type").value = slide.page_type;
        $("board-content").value = slide.content;
        $("board-text").value = slide.required_text;
        $("board-style").value = slide.local_style;
        $("board-notice").textContent = "保存后可按底板生成原图。";
        if (hasTree) {
            $("board-notice").textContent = "改动底板会开始一棵新树，并清空本页选图。已有导出保留原图。";
        }
        $("board-dialog").showModal();
    }));
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
        }
        fields.append(element("dt",name),description);
    }
    card.append(fields);
}

function renderTrash(items) {
    $("trash-button").textContent = "回收站 · " + items.length;
    const list = $("trash-list");
    list.replaceChildren();
    if (items.length === 0) {
        list.append(element("p","暂无已删除页面。","muted"));
    }
    for (const slide of items) {
        const row = element("div",undefined,"section-header");
        row.append(element("span",slide.title),button("恢复到末尾",() => act(() => api("/slides/" + slide.id + "/restore","POST",{}))));
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
        if (slide.selected_node_id !== null) {
            card.append(picture(slide.selected_node_id, "thumb", true));
        } else {
            card.append(element("span", "待生成", "thumb muted"));
        }
        card.append(element("small", (index + 1) + " · " + slide.title));
        list.append(card);
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
            empty.append(element("h2", "创建你的第一套演示稿"), button("新建演示稿", createDeck, "primary"));
        } else if (state.data) {
            empty.append(element("h2", "添加第一页"), button("添加页面", () => addSlide(), "primary"));
        } else {
            empty.append(element("p", "正在加载…", "muted"));
        }
        preview.append(empty);
        return;
    }
    const path = "/slides/" + slide.id;
    const actions = element("div", undefined, "page-actions");
    actions.append(
        button("上移", () => act(() => api(path + "/move", "POST", { direction: "up" })), "", index === 0),
        button("下移", () => act(() => api(path + "/move", "POST", { direction: "down" })), "", index === count - 1),
        button("插入下一页", () => addSlide(slide.id)),
        button("改名", () => askName("修改页面名称", slide.title, (title) => api(path + "/rename", "POST", { title }))),
        button("删除", () => {
            if (window.confirm("删除「" + slide.title + "」？已有的导出文件仍可下载。")) {
                void act(() => api(path, "DELETE"));
            }
        }, "subtle")
    );
    header.append(element("h1", slide.title), actions);
    if (viewed) {
        const image = picture(viewed.id);
        image.alt = slide.title + "的图片版本 " + viewed.id;
        preview.append(image);
    } else {
        const empty = element("div", undefined, "empty-content");
        empty.append(element("span", slide.page_type, "type-chip"), element("h2", slide.title),
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
    const label = element("label", "原图补充要求（可选）");
    if (viewed) {
        label.textContent = "基于版本 #" + viewed.id + " 的修改指令";
    }
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
    const submit = element("button", "生成原图", "primary");
    submit.type = "submit";
    if (viewed) {
        submit.textContent = "生成新分支";
        controls.append(button("设为本页选图", () => act(() => api(path + "/select", "POST", { node: parent })),
            "", slide.selected_node_id === parent));
    } else {
        submit.disabled = rootPending;
        if (rootPending) {
            submit.textContent = "原图生成中";
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
        controls.append(upload, button("上传原图", () => upload.click(), "", rootPending));
    }
    controls.append(submit);
    form.append(label);
    if (viewed?.parent_id != null) {
        form.append(element("p", "基于 #" + viewed.parent_id + " · " + viewed.instruction, "muted version-instruction"));
    }
    form.append(prompt, controls);
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
        list.append(element("p", "生成或上传原图后，版本将显示在这里。", "muted"));
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
        }, "tree-row depth-" + Math.min(depth, 4));
        item.title = "#" + node.id + " · " + (node.instruction ?? label);
        item.setAttribute("aria-label", item.title);
        if (node.id === state.node) {
            item.classList.add("current");
            item.setAttribute("aria-current", "true");
        }
        let prefix = "";
        if (depth > 0) {
            prefix = "↳ ";
        }
        item.append(picture(node.id, "", true), element("span", prefix + "#" + node.id + " " + label));
        if (node.id === slide.selected_node_id) {
            item.append(element("small", "已选"));
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
    list.append(element("h2", "最近的生成任务"));
    for (const job of jobs.slice(0, 10)) {
        const row = element("div", undefined, "job");
        let source = "原图";
        if (job.parent_node_id !== null) {
            source = "基于 #" + job.parent_node_id;
        }
        row.append(element("p", statuses[job.status] + " · " + source));
        if (job.parent_node_id === null) {
            const details = element("details",undefined,"job-details");
            details.append(element("summary","查看原图要求"), element("p",job.instruction,"muted"));
            row.append(details);
        } else {
            row.append(element("p",job.instruction,"muted"));
        }
        if (job.error_message) {
            row.append(element("p", job.error_message, "muted failed"));
            row.append(button("重试", () => act(() => api("/slides/" + job.slide_id + "/retry", "POST", { job: job.id }))));
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
        row.append(element("span", item.format.toUpperCase() + " · " + item.slide_count + " 页 · " + statuses[item.status]));
        if (item.status === "succeeded") {
            const link = element("a", "下载");
            link.href = "/api/exports/" + item.id;
            row.append(link);
        }
        if (item.error_message) {
            row.append(element("p", item.error_message, "muted failed"));
        }
        list.append(row);
    }
}

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
