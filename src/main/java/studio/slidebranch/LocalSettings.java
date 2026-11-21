package studio.slidebranch;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Base64;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.TimeUnit;

final class LocalSettings {
    private final Path file;
    private Properties saved = new Properties();
    private String savedKey = "";

    LocalSettings(Path directory) throws Exception {
        file = directory.resolve("settings.properties");
        if (Files.exists(file)) {
            try (var input = Files.newInputStream(file)) {
                saved.load(input);
            }
            String encrypted = saved.getProperty("rightapiKey", "");
            if (!encrypted.isEmpty()) {
                byte[] plain = protect(Base64.getDecoder().decode(encrypted), false);
                savedKey = new String(plain, StandardCharsets.UTF_8);
            }
        }
    }

    synchronized Images images() {
        String key = savedKey;
        if (key.isEmpty()) {
            key = Images.environment("RIGHTAPI_KEY", "");
        }
        return new Images(key, model(), size());
    }

    private String model() {
        return saved.getProperty("model", Images.environment("IMAGE_MODEL", "gpt-image-2"));
    }

    private String size() {
        return saved.getProperty("size", Images.environment("IMAGE_SIZE", "1536x864"));
    }

    synchronized int generationConcurrency() {
        return Integer.parseInt(saved.getProperty("generationConcurrency", "4"));
    }

    synchronized Map<String,Object> view() {
        return Map.of("model", model(), "size", size(), "savedKey", !savedKey.isEmpty(),
                "environmentKey", !Images.environment("RIGHTAPI_KEY", "").isEmpty(),
                "generationConcurrency", generationConcurrency());
    }

    synchronized void save(String model, String size, String replacement, boolean remove, int concurrency) throws Exception {
        if (concurrency < 0) {
            throw new Problem(400, "并发任务数须为非负整数，0 表示不限。");
        }
        if (!model.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,99}")) {
            throw new Problem(400, "请输入有效的模型名称。");
        }
        if (!size.equals("auto")) {
            if (!size.matches("[1-9][0-9]{0,3}x[1-9][0-9]{0,3}")) {
                throw new Problem(400, "尺寸请使用宽x高，例如 1536x864。");
            }
            String[] parts = size.split("x");
            int w = Integer.parseInt(parts[0]);
            int h = Integer.parseInt(parts[1]);
            if (w % 16 != 0 || h % 16 != 0 || Math.max(w,h) > 3840 || Math.max(w,h) > 3 * Math.min(w,h)
                    || w * h < 655360 || w * h > 8294400) {
                throw new Problem(400, "尺寸不符合绘图服务要求，请选用推荐尺寸。");
            }
        }
        var next = new Properties();
        next.putAll(saved);
        next.setProperty("model", model);
        next.setProperty("size", size);
        next.setProperty("generationConcurrency", Integer.toString(concurrency));
        String nextKey = savedKey;
        if (remove) {
            next.remove("rightapiKey");
            nextKey = "";
        } else if (!replacement.isEmpty()) {
            if (!replacement.matches("[!-~]{1,1024}")) {
                throw new Problem(400, "密钥格式无效。");
            }
            byte[] encrypted = protect(replacement.getBytes(StandardCharsets.UTF_8), true);
            next.setProperty("rightapiKey", Base64.getEncoder().encodeToString(encrypted));
            nextKey = replacement;
        }
        Path temp = Files.createTempFile(file.getParent(), "settings-", ".tmp");
        try {
            try (var output = Files.newOutputStream(temp)) {
                next.store(output, "SlideBranch");
            }
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temp);
        }
        saved = next;
        savedKey = nextKey;
    }

    private static byte[] protect(byte[] input, boolean encrypt) throws Exception {
        String windows = System.getenv("SystemRoot");
        if (windows == null) {
            throw new IOException("本机密钥保存需要 Windows 用户数据保护服务。");
        }
        String method = "Unprotect";
        if (encrypt) {
            method = "Protect";
        }
        String script = "$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.Security\n"
                + "$bytes=[Convert]::FromBase64String([Console]::ReadLine())\n"
                + "$result=[Security.Cryptography.ProtectedData]::" + method
                + "($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)\n"
                + "[Console]::Write([Convert]::ToBase64String($result))";
        Path shell = Path.of(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        var process = new ProcessBuilder(shell.toString(), "-NoProfile", "-NonInteractive", "-Command", script)
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        try {
            try (var stdin = process.getOutputStream()) {
                stdin.write(Base64.getEncoder().encode(input));
                stdin.write('\n');
            }
            if (!process.waitFor(15, TimeUnit.SECONDS) || process.exitValue() != 0) {
                throw new IOException("Windows 密钥保护服务不可用。");
            }
            try (var stdout = process.getInputStream()) {
                return Base64.getDecoder().decode(stdout.readAllBytes());
            }
        } finally {
            process.destroyForcibly();
        }
    }
}
