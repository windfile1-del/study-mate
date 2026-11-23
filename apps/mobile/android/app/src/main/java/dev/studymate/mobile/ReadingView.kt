package dev.studymate.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.view.MotionEvent
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private class StylusAwareWebView(context: Context) : WebView(context) {
    private fun hasStylusPointer(ev: MotionEvent): Boolean {
        for (i in 0 until ev.pointerCount) {
            val type = ev.getToolType(i)
            if (type == MotionEvent.TOOL_TYPE_STYLUS || type == MotionEvent.TOOL_TYPE_ERASER) {
                return true
            }
        }
        return false
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (hasStylusPointer(ev)) {
            // Prevent Compose parents/drag handles from ever stealing S-Pen strokes
            parent?.requestDisallowInterceptTouchEvent(true)
        }
        return super.dispatchTouchEvent(ev)
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ReadingView(
    source: String,
    path: String,
    vaultId: String,
    client: LanClient?,
    modifier: Modifier = Modifier,
    anchor: String = "",
    onNavigate: (String, String, Boolean) -> Unit = { _, _, _ -> },
    conversation: Boolean = false,
    fontSize: Int = 16,
    lineHeight: Float = 1.82f,
    readerTheme: String = "paper",
    scrollTopNonce: Int = 0,
    contentHash: String = "",
    hideTools: Boolean = false,
    inkCommand: String = "",
    inkCommandNonce: Int = 0,
    inkSyncNonce: Int = 0,
) {
    key(client) {
        ReadingContent(
            source = source,
            path = path,
            vaultId = vaultId,
            client = client,
            modifier = modifier,
            anchor = anchor,
            onNavigate = onNavigate,
            conversation = conversation,
            offline = null,
            fontSize = fontSize,
            lineHeight = lineHeight,
            readerTheme = readerTheme,
            scrollTopNonce = scrollTopNonce,
            contentHash = contentHash,
            hideTools = hideTools,
            inkCommand = inkCommand,
            inkCommandNonce = inkCommandNonce,
            inkSyncNonce = inkSyncNonce,
        )
    }
}

@Composable
internal fun OfflineReadingView(
    source: String,
    path: String,
    sourceId: String,
    reader: OfflineReader,
    modifier: Modifier,
    anchor: String,
    fontSize: Int = 16,
    lineHeight: Float = 1.82f,
    readerTheme: String = "paper",
    scrollTopNonce: Int = 0,
    contentHash: String = "",
    hideTools: Boolean = false,
    inkCommand: String = "",
    inkCommandNonce: Int = 0,
    inkSyncNonce: Int = 0,
    onNavigate: (String, String, Boolean) -> Unit,
) {
    key(sourceId, reader.revision) {
        ReadingContent(
            source = source,
            path = path,
            vaultId = sourceId,
            client = null,
            modifier = modifier,
            anchor = anchor,
            onNavigate = onNavigate,
            conversation = false,
            offline = reader,
            fontSize = fontSize,
            lineHeight = lineHeight,
            readerTheme = readerTheme,
            scrollTopNonce = scrollTopNonce,
            contentHash = contentHash,
            hideTools = hideTools,
            inkCommand = inkCommand,
            inkCommandNonce = inkCommandNonce,
            inkSyncNonce = inkSyncNonce,
        )
    }
}

private fun themeBackground(conversation: Boolean, readerTheme: String): Int = when {
    conversation -> Color.rgb(248, 250, 252)
    readerTheme == "warm" -> Color.rgb(251, 247, 238)
    readerTheme == "mint" -> Color.rgb(244, 250, 247)
    else -> Color.rgb(255, 255, 255)
}

private fun escapeJsJson(json: String): String =
    json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun ReadingContent(
    source: String,
    path: String,
    vaultId: String,
    client: LanClient?,
    modifier: Modifier,
    anchor: String,
    onNavigate: (String, String, Boolean) -> Unit,
    conversation: Boolean,
    offline: OfflineReader?,
    fontSize: Int,
    lineHeight: Float,
    readerTheme: String,
    scrollTopNonce: Int,
    contentHash: String,
    hideTools: Boolean,
    inkCommand: String,
    inkCommandNonce: Int,
    inkSyncNonce: Int,
) {
    val latestSource by rememberUpdatedState(source)
    val latestPath by rememberUpdatedState(path)
    val latestVault by rememberUpdatedState(vaultId)
    val latestAnchor by rememberUpdatedState(anchor)
    val latestClient by rememberUpdatedState(client)
    val latestNavigate by rememberUpdatedState(onNavigate)
    val latestConversation by rememberUpdatedState(conversation)
    val latestFontSize by rememberUpdatedState(fontSize)
    val latestLineHeight by rememberUpdatedState(lineHeight)
    val latestTheme by rememberUpdatedState(readerTheme)
    val latestContentHash by rememberUpdatedState(contentHash)
    val latestHideTools by rememberUpdatedState(hideTools)
    val latestInkCommand by rememberUpdatedState(inkCommand)
    val scope = rememberCoroutineScope()
    var ready by remember { mutableStateOf(false) }
    var view by remember { mutableStateOf<WebView?>(null) }
    var handledScrollTop by remember { mutableIntStateOf(scrollTopNonce) }
    var handledInkCommand by remember { mutableIntStateOf(inkCommandNonce) }
    var handledInkSync by remember { mutableIntStateOf(inkSyncNonce) }
    var lastRenderedJson by remember { mutableStateOf<String?>(null) }

    fun buildRenderJson(): String {
        val effectiveHash = if (latestConversation) "" else latestContentHash.ifBlank { NoteInkStore.contentHash(latestSource) }
        return escapeJsJson(
            JSONObject()
                .put("type", "render")
                .put("source", latestSource)
                .put("path", latestPath)
                .put("vaultId", latestVault)
                .put("anchor", latestAnchor)
                .put("conversation", latestConversation)
                .put("fontSize", latestFontSize)
                .put("lineHeight", latestLineHeight.toDouble())
                .put("readerTheme", latestTheme)
                .put("contentHash", effectiveHash)
                .put("hideTools", latestHideTools)
                .toString(),
        )
    }

    fun render(web: WebView, force: Boolean = false) {
        val json = buildRenderJson()
        if (!force && json == lastRenderedJson) return
        lastRenderedJson = json
        web.evaluateJavascript("window.studyReaderReceive && window.studyReaderReceive($json)", null)
    }

    AndroidView(
        modifier = modifier,
        factory = { context ->
            val images = ConcurrentHashMap<String, JSONObject>()
            val inkStore = NoteInkStore(context)
            val loader = WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
                .addPathHandler("/resource/") { id ->
                    val args = images[id] ?: return@addPathHandler WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(byteArrayOf()))
                    runCatching {
                        if (offline != null) return@runCatching offline.image(args)
                        val query = "base=" + java.net.URLEncoder.encode(args.getString("base"), "UTF-8") +
                            "&target=" + java.net.URLEncoder.encode(args.getString("target"), "UTF-8") +
                            "&wiki=" + args.getBoolean("wiki")
                        val response = requireNotNull(latestClient).execute("/v1/notes/image?$query")
                        val body = response.body ?: error("图片没有内容")
                        if (!response.isSuccessful) {
                            response.close()
                            error("图片暂时无法读取")
                        }
                        WebResourceResponse(body.contentType()?.toString()?.substringBefore(';') ?: "image/png", null, body.byteStream())
                    }.getOrElse {
                        WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(byteArrayOf()))
                    }
                }.build()
            StylusAwareWebView(context).apply {
                tag = if (latestConversation) "study-conversation" else "study-note"
                // WebView treats WRAP_CONTENT height as a zero-height layout viewport.
                // Compose supplies the measured size, but Chromium also reads LayoutParams.
                layoutParams = android.view.ViewGroup.LayoutParams(
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                )
                setBackgroundColor(themeBackground(latestConversation, latestTheme))
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                    runCatching {
                        javaClass.getMethod("setAutoHandwritingEnabled", Boolean::class.javaPrimitiveType)
                            .invoke(this, false)
                    }
                    runCatching {
                        settings.javaClass.getMethod("setStylusHandwritingEnabled", Boolean::class.javaPrimitiveType)
                            .invoke(settings, false)
                    }
                }
                webChromeClient = object : android.webkit.WebChromeClient() {
                    override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
                        if (BuildConfig.DEBUG) android.util.Log.d("StudyMateReader", message.message())
                        return true
                    }
                }
                if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        if (request.url.host != "appassets.androidplatform.net") {
                            return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(byteArrayOf()))
                        }
                        return loader.shouldInterceptRequest(request.url)
                            ?: WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(byteArrayOf()))
                    }
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
                    override fun onPageFinished(web: WebView, url: String) {
                        ready = true
                        render(web, force = true)
                    }
                }
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    loadData("请更新 Android System WebView 后阅读学习资料。", "text/plain", "UTF-8")
                } else {
                    WebViewCompat.addWebMessageListener(this, "StudyReader", setOf("https://appassets.androidplatform.net")) { web, message, origin, mainFrame, _ ->
                        if (!mainFrame || origin.toString() != "https://appassets.androidplatform.net") return@addWebMessageListener
                        val text = message.data ?: return@addWebMessageListener
                        if (text.length > 2_000_000) return@addWebMessageListener
                        val input = runCatching { JSONObject(text) }.getOrNull() ?: return@addWebMessageListener
                        val id = input.optInt("id")
                        val operation = input.optString("operation")
                        if (!operation.startsWith("ink_") && text.length > 12000) return@addWebMessageListener
                        val args = input.optJSONObject("input") ?: JSONObject()
                        if (operation == "ready") {
                            ready = true
                            render(web, force = true)
                            return@addWebMessageListener
                        }
                        scope.launch {
                            val reply = JSONObject().put("type", "reply").put("id", id)
                            try {
                                val value = withContext(Dispatchers.IO) {
                                    when (operation) {
                                        "read" -> offline?.note(args.getString("path"))
                                            ?: requireNotNull(latestClient).json("/v1/notes/read", JSONObject().put("path", args.getString("path")))
                                        "resolve" -> offline?.resolve(args)
                                            ?: requireNotNull(latestClient).json("/v1/notes/resolve", args)
                                        "image" -> {
                                            if (images.size >= 256) images.clear()
                                            val imageId = UUID.randomUUID().toString()
                                            images[imageId] = args
                                            "https://appassets.androidplatform.net/resource/$imageId"
                                        }
                                        "navigate" -> {
                                            latestNavigate(args.getString("base"), args.getString("target"), args.getBoolean("wiki"))
                                            JSONObject()
                                        }
                                        "ink_load" -> {
                                            val scopeId = args.optString("scopeId")
                                            val notePath = args.getString("path")
                                            val loaded = inkStore.load(
                                                scopeId,
                                                notePath,
                                                args.optString("contentHash"),
                                            )
                                            val remoteClient = latestClient
                                            if (offline == null && remoteClient != null && notePath.isNotBlank()) {
                                                val localPads = loaded.optJSONArray("pads") ?: JSONArray()
                                                val beforeJson = localPads.toString()
                                                // Sync with desktop asynchronously so opening a note never blocks local ink
                                                scope.launch(Dispatchers.IO) {
                                                    runCatching {
                                                        val synced = remoteClient.json(
                                                            "/v1/notes/ink/sync",
                                                            JSONObject().put("path", notePath).put("pads", localPads),
                                                        )
                                                        val remotePads = synced.optJSONArray("pads")
                                                        if (remotePads != null) {
                                                            val merged = inkStore.mergePads(scopeId, notePath, remotePads)
                                                            if (merged.toString() != beforeJson) {
                                                                web.post {
                                                                    if (view === web) {
                                                                        web.evaluateJavascript(
                                                                            "window.studyReaderReceive && window.studyReaderReceive({type:'reloadInk'})",
                                                                            null,
                                                                        )
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                            loaded
                                        }
                                        "ink_save_pads" -> {
                                            val scopeId = args.optString("scopeId")
                                            val notePath = args.getString("path")
                                            val pads = args.getJSONArray("pads")
                                            inkStore.savePads(scopeId, notePath, pads)
                                            val res = JSONObject().put("ok", true)
                                            val remoteClient = latestClient
                                            if (offline == null && remoteClient != null && notePath.isNotBlank()) {
                                                runCatching {
                                                    val synced = remoteClient.json(
                                                        "/v1/notes/ink/sync",
                                                        JSONObject().put("path", notePath).put("pads", pads),
                                                    )
                                                    val remotePads = synced.optJSONArray("pads")
                                                    if (remotePads != null) {
                                                        val merged = inkStore.mergePads(scopeId, notePath, remotePads)
                                                        res.put("pads", merged)
                                                    }
                                                }
                                            }
                                            res
                                        }
                                        "ink_save_temp" -> {
                                            inkStore.saveTempInk(
                                                args.optString("scopeId"),
                                                args.getString("path"),
                                                args.optString("contentHash"),
                                                args.getJSONArray("strokes"),
                                            )
                                            JSONObject().put("ok", true)
                                        }
                                        "ink_clear_temp" -> {
                                            inkStore.clearTempInk(
                                                args.optString("scopeId"),
                                                args.getString("path"),
                                            )
                                            JSONObject().put("ok", true)
                                        }
                                        else -> error("不支持的阅读操作")
                                    }
                                }
                                reply.put("value", value)
                            } catch (e: Exception) {
                                reply.put("error", e.message ?: "读取失败")
                            }
                            val escaped = escapeJsJson(reply.toString())
                            // The HTTP coroutine can resume under a different continuation interceptor.
                            // WebView access must always be posted to the view's own main-thread handler.
                            web.post {
                                if (view === web) {
                                    web.evaluateJavascript("window.studyReaderReceive && window.studyReaderReceive($escaped)", null)
                                }
                            }
                        }
                    }
                    loadUrl("https://appassets.androidplatform.net/assets/reader/index.html")
                }
                view = this
            }
        },
        update = { web ->
            web.tag = if (latestConversation) "study-conversation" else "study-note"
            web.setBackgroundColor(themeBackground(latestConversation, latestTheme))
            if (ready) {
                render(web)
                if (scrollTopNonce != handledScrollTop) {
                    handledScrollTop = scrollTopNonce
                    web.evaluateJavascript("window.studyReaderReceive && window.studyReaderReceive({type:'scrollTop'})", null)
                }
                if (inkCommandNonce != handledInkCommand && latestInkCommand.isNotBlank()) {
                    handledInkCommand = inkCommandNonce
                    val cmdPayload = escapeJsJson(JSONObject().put("type", "inkCommand").put("command", latestInkCommand).toString())
                    web.evaluateJavascript("window.studyReaderReceive && window.studyReaderReceive($cmdPayload)", null)
                }
                if (inkSyncNonce != handledInkSync) {
                    handledInkSync = inkSyncNonce
                    web.evaluateJavascript("window.studyReaderReceive && window.studyReaderReceive({type:'reloadInk'})", null)
                }
            }
        },
        onRelease = { web ->
            web.stopLoading()
            web.destroy()
            view = null
        },
    )
}
