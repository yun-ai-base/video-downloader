package com.videodownloader.app;

import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private LinearLayout connectLayout;
    private EditText urlInput;
    private Button connectBtn;
    private ProgressBar progressBar;
    private static final String PREFS_NAME = "VideoDownloader";
    private static final String KEY_SERVER_URL = "server_url";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 主布局
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        // 连接界面
        connectLayout = createConnectLayout();
        root.addView(connectLayout);

        // WebView
        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setVisibility(View.GONE);

        // 进度条
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                6));
        progressBar.setVisibility(View.GONE);

        FrameLayout webContainer = new FrameLayout(this);
        webContainer.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        webContainer.addView(webView);
        webContainer.addView(progressBar);

        root.addView(webContainer);
        setContentView(root);

        setupWebView();

        // 检查已保存的 URL
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String savedUrl = prefs.getString(KEY_SERVER_URL, "");
        if (!savedUrl.isEmpty()) {
            connectToServer(savedUrl);
        }
    }

    private LinearLayout createConnectLayout() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        layout.setPadding(40, 80, 40, 40);

        // Logo / 标题
        TextView title = new TextView(this);
        title.setText("🌐 视频下载器");
        title.setTextSize(28);
        title.setTextAlignment(View.TEXT_ALIGNMENT_CENTER);
        title.setPadding(0, 0, 0, 8);

        // 副标题
        TextView subtitle = new TextView(this);
        subtitle.setText("粘贴视频链接 → 一键下载\n支持抖音/快手/B站/YouTube/小红书");
        subtitle.setTextSize(14);
        subtitle.setPadding(0, 0, 0, 32);

        // 服务器地址输入
        TextView label = new TextView(this);
        label.setText("服务器地址");
        label.setTextSize(14);
        label.setPadding(0, 0, 0, 8);

        urlInput = new EditText(this);
        urlInput.setHint("https://yourapp.up.railway.app");
        urlInput.setTextSize(16);
        urlInput.setPadding(20, 16, 20, 16);

        // 说明
        TextView hint = new TextView(this);
        hint.setText("输入部署好的云端服务地址，或留空点击连接使用默认");
        hint.setTextSize(11);
        hint.setPadding(10, 6, 10, 24);

        // 连接按钮
        connectBtn = new Button(this);
        connectBtn.setText("连接");
        connectBtn.setTextSize(16);

        // 下方提示
        TextView tip = new TextView(this);
        tip.setText("💡 云端版不需电脑运行\n部署一次，所有朋友都能用");
        tip.setTextSize(12);
        tip.setTextAlignment(View.TEXT_ALIGNMENT_CENTER);
        tip.setPadding(10, 40, 10, 10);

        connectBtn.setOnClickListener(v -> connect());
        urlInput.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO) {
                connect();
                return true;
            }
            return false;
        });

        layout.addView(title);
        layout.addView(subtitle);
        layout.addView(label);
        layout.addView(urlInput);
        layout.addView(hint);
        layout.addView(connectBtn);
        layout.addView(tip);

        return layout;
    }

    private void connect() {
        String url = urlInput.getText().toString().trim();

        // 如果没填，试试默认地址（用户部署后可修改）
        if (url.isEmpty()) {
            url = "https://video-downloader-production.up.railway.app";
        }

        // 补齐 https://
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url;
        }
        // 去掉尾部 /
        if (url.endsWith("/")) url = url.substring(0, url.length() - 1);

        connectToServer(url);
    }

    private void connectToServer(String url) {
        // 保存URL
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(KEY_SERVER_URL, url)
                .apply();

        connectLayout.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " VideoDownloader-Android");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(0);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                progressBar.setVisibility(View.GONE);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
