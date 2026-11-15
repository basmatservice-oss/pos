package com.basmatservice.davincipos;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

public class MainActivity extends Activity {
    private static final String BASE_URL = "http://localhost:3187";
    private static boolean nodeStarted = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private String bootstrapToken = "";

    static {
        System.loadLibrary("node");
        System.loadLibrary("davincipos-native");
    }

    private native int startNodeWithArguments(String[] arguments, String workingDirectory);

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        showStartingScreen();
        try {
            File project = new File(getFilesDir(), "nodejs-project");
            if (!new File(project, "server.js").exists()) copyAssetFolder("nodejs-project", project);
            prepareEnvironment(project);
            if (!nodeStarted) {
                nodeStarted = true;
                Thread nodeThread = new Thread(() -> startNodeWithArguments(
                    new String[]{"node", "--env-file=" + new File(getFilesDir(), "davincipos.env").getAbsolutePath(), "server.js"},
                    project.getAbsolutePath()
                ), "DavinciPos-Node");
                nodeThread.setDaemon(false);
                nodeThread.start();
            }
            waitForServer(0);
        } catch (Exception error) {
            showFatal("تعذر تجهيز DavinciPos: " + error.getMessage());
        }
    }

    private void showStartingScreen() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(36, 36, 36, 36);
        layout.setBackgroundColor(Color.rgb(245, 247, 251));
        TextView title = new TextView(this);
        title.setText("DavinciPos");
        title.setTextSize(28);
        title.setTextColor(Color.rgb(25, 40, 70));
        title.setGravity(Gravity.CENTER);
        layout.addView(title, new LinearLayout.LayoutParams(-1, -2));
        ProgressBar progress = new ProgressBar(this);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
        params.topMargin = 28;
        layout.addView(progress, params);
        TextView status = new TextView(this);
        status.setText("جاري تشغيل قاعدة البيانات وخدمات النظام محلياً...");
        status.setTextSize(15);
        status.setTextColor(Color.DKGRAY);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, 20, 0, 0);
        layout.addView(status, new LinearLayout.LayoutParams(-1, -2));
        setContentView(layout);
    }

    private void prepareEnvironment(File project) throws Exception {
        File env = new File(getFilesDir(), "davincipos.env");
        File tokenFile = new File(getFilesDir(), "bootstrap-token.txt");
        if (tokenFile.exists()) bootstrapToken = readFile(tokenFile);
        else {
            byte[] bytes = new byte[32];
            new SecureRandom().nextBytes(bytes);
            bootstrapToken = Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            writeFile(tokenFile, bootstrapToken);
        }
        String content = "HOST=127.0.0.1\n" +
            "PORT=3187\n" +
            "DAVINCIPOS_DB=" + new File(getFilesDir(), "DavinciPos.sqlite").getAbsolutePath() + "\n" +
            "DAVINCIPOS_SQLITE_BINDING=" + new File(project, "native/" + Build.SUPPORTED_ABIS[0] + "/better_sqlite3.node").getAbsolutePath() + "\n" +
            "DAVINCIPOS_BOOTSTRAP_TOKEN=" + bootstrapToken + "\n";
        writeFile(env, content);
    }

    private void waitForServer(int attempt) {
        new Thread(() -> {
            JSONObject health = null;
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(BASE_URL + "/api/health").openConnection();
                connection.setConnectTimeout(700);
                connection.setReadTimeout(700);
                if (connection.getResponseCode() == 200) {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
                    StringBuilder body = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) body.append(line);
                    health = new JSONObject(body.toString());
                }
                connection.disconnect();
            } catch (Exception ignored) {}
            final JSONObject result = health;
            handler.post(() -> {
                if (result != null) {
                    if (result.optBoolean("bootstrapRequired", false)) showBootstrapToken();
                    else {
                        new File(getFilesDir(), "bootstrap-token.txt").delete();
                        bootstrapToken = "";
                    }
                    showApplication();
                } else if (attempt >= 60) {
                    showFatal("لم يبدأ خادم DavinciPos المحلي. أعد تشغيل التطبيق أو أرسل سجل الخطأ.");
                } else handler.postDelayed(() -> waitForServer(attempt + 1), 500);
            });
        }, "DavinciPos-Health").start();
    }

    private void showBootstrapToken() {
        new AlertDialog.Builder(this)
            .setTitle("رمز تهيئة المالك")
            .setMessage("انسخ هذا الرمز وأدخله في شاشة إنشاء حساب المالك الأولى:\n\n" + bootstrapToken)
            .setPositiveButton("نسخ الرمز", (dialog, which) -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(ClipData.newPlainText("DavinciPos bootstrap token", bootstrapToken));
                Toast.makeText(this, "تم نسخ رمز التهيئة", Toast.LENGTH_LONG).show();
            })
            .setNegativeButton("متابعة", null)
            .show();
    }

    private void showApplication() {
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient());
        setContentView(webView);
        webView.loadUrl(BASE_URL + "/mobile");
    }

    private void showFatal(String message) {
        TextView view = new TextView(this);
        view.setText("DavinciPos\n\n" + message);
        view.setTextSize(16);
        view.setTextColor(Color.DKGRAY);
        view.setPadding(32, 48, 32, 32);
        setContentView(view);
    }

    private void copyAssetFolder(String assetPath, File destination) throws Exception {
        if (!destination.exists() && !destination.mkdirs()) throw new Exception("Cannot create app data directory");
        String[] children = getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            try (InputStream input = getAssets().open(assetPath); FileOutputStream output = new FileOutputStream(destination)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) > 0) output.write(buffer, 0, count);
            }
            return;
        }
        for (String child : children) copyAssetFolder(assetPath + "/" + child, new File(destination, child));
    }

    private String readFile(File file) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            StringBuilder value = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) value.append(line);
            return value.toString();
        }
    }

    private void writeFile(File file, String value) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
