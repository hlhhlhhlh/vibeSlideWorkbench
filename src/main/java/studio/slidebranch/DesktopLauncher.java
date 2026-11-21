package studio.slidebranch;

import java.awt.Desktop;
import java.awt.FlowLayout;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.SwingUtilities;

public final class DesktopLauncher {
    private DesktopLauncher() {}

    public static void main(String[] args) {
        try {
            Path defaultData = Path.of(System.getenv("LOCALAPPDATA"), "SlideBranch", "data");
            Path data = Path.of(Images.environment("SLIDEBRANCH_DATA", defaultData.toString()));
            int port = Integer.parseInt(Images.environment("SLIDEBRANCH_PORT", "0"));
            int boundPort = Main.start(Files.createDirectories(data.toAbsolutePath()), port);
            URI address = URI.create("http://127.0.0.1:" + boundPort + "/");
            SwingUtilities.invokeLater(() -> showWindow(address));
        } catch (Exception failure) {
            JOptionPane.showMessageDialog(null, failure.getMessage(), "SlideBranch 启动失败", JOptionPane.ERROR_MESSAGE);
            System.exit(1);
        }
    }

    private static void showWindow(URI address) {
        JFrame window = new JFrame("SlideBranch");
        JButton open = new JButton("打开工作台");
        open.addActionListener(event -> {
            try {
                Desktop.getDesktop().browse(address);
            } catch (Exception failure) {
                JOptionPane.showInputDialog(window, "请复制此地址到浏览器打开工作台", address.toString());
            }
        });
        JButton exit = new JButton("退出");
        exit.addActionListener(event -> System.exit(0));
        JPanel panel = new JPanel(new FlowLayout(FlowLayout.CENTER, 16, 16));
        panel.add(new JLabel("工作台已启动"));
        panel.add(open);
        panel.add(exit);
        window.setContentPane(panel);
        window.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        window.pack();
        window.setLocationRelativeTo(null);
        window.setVisible(true);
        open.doClick();
    }
}
