"use strict";
(() => {
    let theme = "light";
    try {
        const saved = localStorage.getItem("slidebranch-theme");
        if (saved === "light" || saved === "paper") {
            theme = saved;
        }
    } catch {
        // 无法读取本地存储时使用默认主题
    }
    document.documentElement.dataset.theme = theme;
})();
