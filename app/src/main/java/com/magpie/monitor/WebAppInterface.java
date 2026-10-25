package com.magpie.monitor;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

public class WebAppInterface implements Runnable {
    private final Context context;
    private final SharedPreferences prefs;
    private final Handler mainHandler;
    private volatile String pendingToast = null;
    private volatile String pendingClip = null;

    private static class ClipboardReader implements Runnable {
        private final Context ctx;
        private final String[] out;
        private final Object lock;

        ClipboardReader(Context ctx, String[] out, Object lock) {
            this.ctx = ctx;
            this.out = out;
            this.lock = lock;
        }

        @Override
        public void run() {
            try {
                ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null && cm.hasPrimaryClip()) {
                    ClipData clip = cm.getPrimaryClip();
                    if (clip != null && clip.getItemCount() > 0) {
                        CharSequence cs = clip.getItemAt(0).getText();
                        if (cs != null) {
                            out[0] = cs.toString().trim();
                        }
                    }
                }
            } catch (Exception ignored) {}
            synchronized (lock) {
                lock.notifyAll();
            }
        }
    }

    public WebAppInterface(Context context) {
        this.context = context;
        this.prefs = context.getSharedPreferences("magpie_monitor_prefs", Context.MODE_PRIVATE);
        this.mainHandler = new Handler(Looper.getMainLooper());
    }

    @JavascriptInterface
    public String loadConfig(String key, String defValue) {
        return prefs.getString(key, defValue);
    }

    @JavascriptInterface
    public void saveConfig(String key, String value) {
        prefs.edit().putString(key, value).apply();
    }

    @JavascriptInterface
    public void showToast(String message) {
        this.pendingToast = message;
        mainHandler.post(this);
    }

    @JavascriptInterface
    public void copyToClipboard(String text) {
        this.pendingClip = text;
        mainHandler.post(this);
    }

    @JavascriptInterface
    public String getClipboardText() {
        final String[] result = new String[]{""};
        final Object lock = new Object();
        mainHandler.post(new ClipboardReader(context, result, lock));
        synchronized (lock) {
            try {
                lock.wait(600);
            } catch (InterruptedException ignored) {}
        }
        return result[0];
    }

    @Override
    public void run() {
        if (pendingToast != null) {
            Toast.makeText(context, pendingToast, Toast.LENGTH_SHORT).show();
            pendingToast = null;
        }
        if (pendingClip != null) {
            ClipboardManager cm = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("Magpie", pendingClip));
                Toast.makeText(context, "已复制到剪贴板", Toast.LENGTH_SHORT).show();
            }
            pendingClip = null;
        }
    }

    @JavascriptInterface
    public String httpRequest(String urlStr, String method, String headersJson, String body) {
        JSONObject result = new JSONObject();
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod(method != null && !method.isEmpty() ? method.toUpperCase() : "GET");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(20000);
            conn.setUseCaches(false);

            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject headers = new JSONObject(headersJson);
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    conn.setRequestProperty(k, headers.getString(k));
                }
            }

            if (body != null && !body.isEmpty() && !"GET".equalsIgnoreCase(method)) {
                conn.setDoOutput(true);
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(bytes);
                }
            }

            int code = conn.getResponseCode();
            result.put("status", code);

            InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
            if (is != null) {
                StringBuilder sb = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        sb.append(line).append('\n');
                    }
                }
                result.put("data", sb.toString());
            } else {
                result.put("data", "");
            }
            result.put("error", JSONObject.NULL);
        } catch (Exception e) {
            try {
                result.put("status", 0);
                result.put("data", "");
                result.put("error", e.getMessage() != null ? e.getMessage() : e.toString());
            } catch (Exception ignored) {}
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
        return result.toString();
    }
}
