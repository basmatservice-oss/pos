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
import android.util.Log;
import android.view.Gravity;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.EditText;
import android.text.InputType;
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
    private String remoteServerUrl = "";
    private boolean remoteMode = false;
    private boolean remoteOnlyMode = false;

    private native int startNodeWithArguments(String[] arguments, String workingDirectory);

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        remoteServerUrl = getPreferences(0).getString("remote_server_url", "");
        showStartingScreen();
        // A saved LAN server is a complete operating mode. Do not load or start
        // the embedded Node/JNI runtime before opening the remote server.
        if (!remoteServerUrl.isEmpty()) {
            remoteOnlyMode = true;
            showApplication();
            return;
        }
        try {
            // Load native libraries after rendering the startup screen so linker
            // failures are shown as diagnostics instead of an immediate silent exit.
            System.loadLibrary("node");
            System.loadLibrary("davincipos-native");
            File project = new File(getFilesDir(), "nodejs-project-" + BuildConfig.VERSION_NAME);
            if (!new File(project, "server.js").exists()) copyAssetFolder("nodejs-project", project);
            prepareEnvironment(project);
            if (!nodeStarted) {
                nodeStarted = true;
                Thread nodeThread = new Thread(() -> {
                    try {
                        int exitCode = startNodeWithArguments(
                            new String[]{"node", "--env-file=" + new File(getFilesDir(), "davincipos.env").getAbsolutePath(), "server.js"},
                            project.getAbsolutePath()
                        );
                        nodeStarted = false;
                        handler.post(() -> showFatal("توقف محرك Node.js أثناء بدء الخدمة. رمز الخروج: " + exitCode));
                    } catch (Throwable failure) {
                        nodeStarted = false;
                        Log.e("DavinciPos", "Embedded Node.js failed", failure);
                        handler.post(() -> showFatal("فشل تشغيل محرك Node.js: " + failure.getClass().getSimpleName() + ": " + failure.getMessage()));
                    }
                }, "DavinciPos-Node");
                nodeThread.setDaemon(false);
                nodeThread.start();
            }
            waitForServer(0);
        } catch (Throwable error) {
            Log.e("DavinciPos", "Application startup failed", error);
            showFatal("تعذر بدء التطبيق: " + error.getClass().getSimpleName() + ": " + error.getMessage());
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
        TextView lanButton = new TextView(this);
        lanButton.setText("إعداد الاتصال بخادم الكمبيوتر عبر Wi-Fi / LAN");
        lanButton.setTextSize(15);
        lanButton.setTextColor(Color.WHITE);
        lanButton.setGravity(Gravity.CENTER);
        lanButton.setPadding(24, 18, 24, 18);
        lanButton.setBackgroundColor(Color.rgb(75, 91, 190));
        LinearLayout.LayoutParams lanParams = new LinearLayout.LayoutParams(-1, -2);
        lanParams.topMargin = 28;
        layout.addView(lanButton, lanParams);
        lanButton.setOnClickListener(view -> showRemoteServerDialog());
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
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                return !("https".equals(scheme) || ("http".equals(scheme) && "localhost".equals(request.getUrl().getHost())));
            }
            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame() && remoteMode) {
                    remoteMode = false;
                    view.post(() -> {
                        if (remoteOnlyMode) {
                            showFatal("تعذر الاتصال بخادم المتجر عبر LAN. تحقق من تشغيل خادم الكمبيوتر وعنوان IP والمنفذ وشهادة HTTPS، ثم أعد فتح التطبيق.");
                        } else {
                            view.loadUrl(BASE_URL + "/mobile");
                            Toast.makeText(MainActivity.this, "تعذر فتح خادم المتجر؛ تم فتح قاعدة الهاتف المحلية المستقلة.", Toast.LENGTH_LONG).show();
                        }
                    });
                }
            }
        });
        setContentView(webView);
        if (!remoteServerUrl.isEmpty()) {
            remoteMode = true;
            webView.loadUrl(remoteServerUrl);
        } else webView.loadUrl(BASE_URL + "/mobile");
    }

    private void showFatal(String message) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER_VERTICAL);
        layout.setPadding(32, 40, 32, 40);
        layout.setBackgroundColor(Color.rgb(245, 247, 251));
        TextView view = new TextView(this);
        view.setText("DavinciPos\n\n" + message);
        view.setTextSize(16);
        view.setTextColor(Color.DKGRAY);
        layout.addView(view, new LinearLayout.LayoutParams(-1, -2));
        TextView lanButton = new TextView(this);
        lanButton.setText("إعداد الاتصال بخادم الكمبيوتر عبر Wi-Fi / LAN");
        lanButton.setTextSize(15);
        lanButton.setTextColor(Color.WHITE);
        lanButton.setGravity(Gravity.CENTER);
        lanButton.setPadding(24, 18, 24, 18);
        lanButton.setBackgroundColor(Color.rgb(75, 91, 190));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = 24;
        layout.addView(lanButton, params);
        lanButton.setOnClickListener(button -> showRemoteServerDialog());
        setContentView(layout);
    }

    private void copyAssetFolder(String assetPath, File destination) throws Exception {
        if (!destination.exists() && !destination.mkdirs()) throw new Exception("Cannot create app data directory");
        String[] children = getAssets().list(assetPath);
        if (children != null && children.length > 0) {
            for (String child : children) copyAssetFolder(assetPath + "/" + child, new File(destination, child));
            return;
        }
        try (InputStream input = getAssets().open(assetPath); FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) > 0) output.write(buffer, 0, count);
        } catch (java.io.FileNotFoundException emptyDirectory) {
            if (!destination.exists() && !destination.mkdirs()) throw new Exception("Cannot create empty app asset directory");
        }
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

    private void probeRemoteServer(String serverUrl, boolean fallbackToLocal) {
        new Thread(() -> {
            boolean reachable = false;
            try {
                String healthUrl = serverUrl.substring(0, serverUrl.length() - "/mobile".length()) + "/api/health";
                HttpURLConnection connection = (HttpURLConnection) new URL(healthUrl).openConnection();
                connection.setConnectTimeout(2500);
                connection.setReadTimeout(2500);
                reachable = connection.getResponseCode() == 200;
                connection.disconnect();
            } catch (Exception ignored) {}
            final boolean connected = reachable;
            handler.post(() -> {
                if (connected) {
                    remoteMode = true;
                    remoteOnlyMode = true;
                    if (webView == null) showApplication();
                    else webView.loadUrl(serverUrl);
                } else if (fallbackToLocal) {
                    remoteMode = false;
                    webView.loadUrl(BASE_URL + "/mobile");
                    Toast.makeText(this, "خادم المتجر غير متاح؛ تم فتح قاعدة الهاتف المستقلة. بياناتها لا تندمج تلقائياً مع قاعدة الكمبيوتر.", Toast.LENGTH_LONG).show();
                } else {
                    Toast.makeText(this, "تعذر الاتصال. تحقق من عنوان الخادم وشبكة LAN وشهادة الأمان.", Toast.LENGTH_LONG).show();
                }
            });
        }, "DavinciPos-RemoteProbe").start();
    }

    private void showRemoteServerDialog() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://192.168.1.10:3187/mobile");
        input.setText(remoteServerUrl);
        new AlertDialog.Builder(this)
            .setTitle("الاتصال بخادم المتجر عبر LAN")
            .setMessage("أدخل عنوان خادم الكمبيوتر على شبكة Wi-Fi أو LAN. يجب أن يبدأ بـ HTTPS وينتهي بـ /mobile، وأن تكون شهادة الخادم موثوقة على الهاتف.")
            .setView(input)
            .setNegativeButton("إلغاء", null)
            .setNeutralButton("مسح العنوان", (dialog, which) -> {
                remoteServerUrl = "";
                getPreferences(0).edit().remove("remote_server_url").apply();
                remoteMode = false;
                if (remoteOnlyMode) {
                    showFatal("تم مسح عنوان خادم LAN. أعد تشغيل التطبيق لبدء الوضع المحلي.");
                } else if (webView != null) webView.loadUrl(BASE_URL + "/mobile");
            })
            .setPositiveButton("اتصال", (dialog, which) -> {
                String value = input.getText().toString().trim();
                if (!value.startsWith("https://") || !value.endsWith("/mobile") || value.contains(" ")) {
                    Toast.makeText(this, "عنوان الخادم غير صالح؛ استخدم HTTPS وينتهي بـ /mobile", Toast.LENGTH_LONG).show();
                    return;
                }
                remoteServerUrl = value;
                getPreferences(0).edit().putString("remote_server_url", remoteServerUrl).apply();
                probeRemoteServer(remoteServerUrl, false);
            })
            .show();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && remoteOnlyMode) {
            showRemoteServerDialog();
        } else if (webView != null && remoteMode) {
            remoteMode = false;
            webView.loadUrl(BASE_URL + "/mobile");
        } else if (webView != null) showRemoteServerDialog();
        else super.onBackPressed();
    }
}
