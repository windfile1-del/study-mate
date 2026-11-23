package dev.studymate.mobile

import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.lifecycle.ViewModelProvider
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.semantics.SemanticsActions
import org.junit.runner.RunWith
import android.graphics.Rect
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class LanLearningTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun until(label: String = "设备学习状态", predicate: () -> Boolean) { repeat(150) { compose.waitForIdle(); if (predicate()) return; Thread.sleep(200) }; error("等待超时：$label") }
    private fun views(root: View): List<WebView> = buildList { if (root is WebView) add(root); if (root is ViewGroup) for (i in 0 until root.childCount) addAll(views(root.getChildAt(i))) }
    private fun clickText(text: String) {
        compose.onNodeWithText(text, useUnmergedTree = false).performClick()
    }
    private fun productPlayer(scenario: ActivityScenario<MainActivity>, model: StudyViewModel, client: LanClient, sourceId: String, prefix: String) {
        scenario.onActivity { it.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
        until("正式播放器横屏布局稳定") { var ok = false; scenario.onActivity { ok = it.window.decorView.width > it.window.decorView.height }; ok }
        val row = model.ui.value.videos.first { it.getString("id") == sourceId }
        scenario.onActivity { model.openVideo(row) }
        until("正式播放器持续输出首帧") {
            var ok = false
            scenario.onActivity {
                val p = model.playback.player
                ok = p != null && p.playbackState == Player.STATE_READY && (p.videoDecoderCounters?.renderedOutputBufferCount ?: 0) > 0
                assertTrue(model.playback.ui.value.error, model.playback.ui.value.error.isBlank())
            }; ok
        }
        clickText("暂停")
        val duration = model.playback.ui.value.duration
        assertTrue(duration > 3)
        // Exercise the accessibility action used by the real seek slider, not a test-only player.
        val target = minOf(duration * 0.4, 30.0)
        compose.onNodeWithTag("video-seek").performSemanticsAction(SemanticsActions.SetProgress) { it(target.toFloat()) }
        until("拖动跳转完成") { kotlin.math.abs(model.playback.ui.value.position - target) < 0.7 }
        clickText("1.0× 倍速"); clickText("1.5×")
        until { model.playback.ui.value.rate == 1.5f }
        capturePlayer(scenario, "$prefix-player-landscape.png", true)
        clickText("全屏")
        until { model.playback.ui.value.fullscreen }
        capturePlayer(scenario, "$prefix-player-fullscreen.png", true)
        clickText("退出全屏")
        scenario.onActivity { it.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
        until { var portrait = false; scenario.onActivity { portrait = it.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT }; portrait }
        until("竖屏窗口布局稳定") { var ok = false; scenario.onActivity { ok = it.window.decorView.width < it.window.decorView.height }; ok }
        capturePlayer(scenario, "$prefix-player-portrait.png", false)
        clickText("就此刻提问")
        until { model.ui.value.questionVideo != null }
        val frozen = requireNotNull(model.ui.value.questionVideo)
        assertEquals(target, frozen.position, 0.7)
        scenario.onActivity { model.playback.seek(0.5) }
        assertEquals(frozen.position, model.ui.value.questionVideo!!.position, 0.01)
        scenario.onActivity { model.draft("阶段3视频时间点问题 $prefix") }
        kotlinx.coroutines.runBlocking { model.send().join() }
        until("冻结的视频问题完成") { model.ui.value.pendingRequest == null && !model.ui.value.chat.optBoolean("busy") }
        // Return to the same source and restore the frozen position before an explicit handoff.
        scenario.onActivity { model.clearVideoQuestion(); model.tab(3); model.playback.seek(target) }
        clickText("发回电脑续播")
        until("接力请求送达电脑") { model.playback.ui.value.notice.contains("请在电脑") }
        val proof = JSONObject().put("sourceId", sourceId).put("target", target).put("duration", duration).put("rate", model.playback.ui.value.rate)
            .put("frozenQuestionPosition", frozen.position)
        until("电脑确认后的续播进度") {
            val rows = client.json("/v1/videos").getJSONArray("videos")
            val desktop = (0 until rows.length()).map { rows.getJSONObject(it) }.first { it.getString("id") == sourceId }.optJSONObject("desktop")
            desktop != null && desktop.optDouble("position") >= target - 0.7 && kotlin.math.abs(desktop.optDouble("rate") - 1.5) < 0.01
        }
        // Reopen the same course: this device checkpoint must win over the desktop's later position.
        scenario.onActivity { model.openVideo(row) }
        until { model.playback.ui.value.duration > 0 && !model.playback.ui.value.loading }
        scenario.onActivity { model.playback.pause() }
        assertEquals(target, model.playback.ui.value.position, 1.5)
        scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
        assertNull(model.playback.player)
        scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        until { model.ui.value.connected && model.playback.player != null && !model.playback.ui.value.loading }
        assertFalse(model.playback.ui.value.playing)
        proof.put("backgroundReleased", true).put("reopenPosition", model.playback.ui.value.position)
        val desktopRows = client.json("/v1/videos").getJSONArray("videos")
        val desktop = (0 until desktopRows.length()).map { desktopRows.getJSONObject(it) }.first { it.getString("id") == sourceId }.getJSONObject("desktop")
        val revision = model.playback.ui.value.revision
        clickText("读取电脑进度")
        until("电脑到平板的明确进度接力") { model.playback.ui.value.revision > revision && model.playback.player != null && !model.playback.ui.value.loading && model.playback.ui.value.duration > 0 }
        scenario.onActivity { model.playback.pause() }
        assertEquals(desktop.getDouble("position"), model.playback.ui.value.position, 2.0)
        assertEquals(1.5f, model.playback.ui.value.rate)
        proof.put("computerResumePosition", model.playback.ui.value.position)
        java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "$prefix-player.json").writeText(proof.toString(2))
    }
    private fun capturePlayer(scenario: ActivityScenario<MainActivity>, name: String, landscape: Boolean) {
        compose.waitForIdle()
        val frame = CountDownLatch(1)
        scenario.onActivity { activity ->
            val decor = activity.window.decorView
            decor.viewTreeObserver.registerFrameCommitCallback { frame.countDown() }
            decor.postOnAnimation { decor.invalidate() }
        }
        assertTrue("播放器布局必须真实提交到渲染管线", frame.await(5, TimeUnit.SECONDS))
        capture(name)
        val bitmap = android.graphics.BitmapFactory.decodeFile(java.io.File(instrumentation.targetContext.getExternalFilesDir(null), name).path)
        assertEquals("截图方向必须与命名和实际验收布局一致", landscape, bitmap.width > bitmap.height)
        bitmap.recycle()
    }
    private fun capture(name: String, readers: List<Rect> = emptyList()) {
        compose.waitForIdle()
        Thread.sleep(400)
        val screenshot = instrumentation.uiAutomation.takeScreenshot()
        java.io.File(instrumentation.targetContext.getExternalFilesDir(null), name).outputStream().use { screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        for (rect in readers) {
            var ink = 0
            for (y in (rect.top + 24).coerceAtLeast(0) until (rect.bottom - 24).coerceAtMost(screenshot.height) step 2)
                for (x in (rect.left + 24).coerceAtLeast(0) until (rect.right - 24).coerceAtMost(screenshot.width) step 2) {
                    val pixel = screenshot.getPixel(x, y)
                    if (android.graphics.Color.red(pixel) < 160 && android.graphics.Color.green(pixel) < 160 && android.graphics.Color.blue(pixel) < 160) ink++
                }
            assertTrue("阅读区截图必须包含可见文字，不能只检查隐藏 DOM：$rect ink=$ink", ink > 100)
        }
        screenshot.recycle()
    }
    private fun flushReaders(scenario: ActivityScenario<MainActivity>): List<Rect> {
        val latches = mutableListOf<CountDownLatch>()
        val diagnostics = java.util.concurrent.CopyOnWriteArrayList<String>()
        val bounds = mutableListOf<Rect>()
        scenario.onActivity { activity ->
            for (reader in views(activity.window.decorView)) {
                val rect = Rect(); val visible = reader.getGlobalVisibleRect(rect)
                println("STUDYMATE_READER_BOUNDS width=${reader.width} height=${reader.height} visible=$visible rect=$rect")
                assertTrue("阅读 WebView 必须有真实显示面积：$rect", visible && reader.width > 300 && reader.height > 300)
                bounds.add(rect)
                val geometry = CountDownLatch(1); latches.add(geometry)
                reader.evaluateJavascript("JSON.stringify({viewport:[innerWidth,innerHeight],elements:[...document.querySelectorAll('html,body,#root,.note-preview,.note-reading-tools,.note-preview-scroll,.note-rendered-block,.katex')].slice(0,15).map(e=>({tag:e.tagName,cls:e.className,rect:e.getBoundingClientRect().toJSON(),color:getComputedStyle(e).color,visibility:getComputedStyle(e).visibility,opacity:getComputedStyle(e).opacity})),text:document.body.innerText})") { value ->
                    diagnostics.add("native=$rect js=$value"); geometry.countDown()
                }
                val latch = CountDownLatch(1); latches.add(latch)
                reader.postVisualStateCallback(System.nanoTime(), object : WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) { reader.invalidate(); latch.countDown() }
                })
            }
        }
        assertTrue("需要实际的阅读视图", latches.isNotEmpty())
        for (latch in latches) assertTrue("阅读内容必须提交到绘制管线", latch.await(5, TimeUnit.SECONDS))
        instrumentation.waitForIdleSync()
        java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "reader-geometry.txt").appendText(diagnostics.joinToString("\n") + "\n")
        for (diagnostic in diagnostics) {
            val result = diagnostic.substringAfter(" js=")
            val payload = JSONObject(org.json.JSONTokener(result).nextValue() as String)
            val viewport = payload.getJSONArray("viewport")
            val html = payload.getJSONArray("elements").getJSONObject(0).getJSONObject("rect")
            assertTrue("页面根节点高度应匹配可见阅读区：$diagnostic", html.getDouble("height") >= viewport.getDouble(1) * 0.9)
        }
        return bounds
    }
    @Test fun pairedTlsNotesChatAndRealReader() {
        val args = InstrumentationRegistry.getArguments()
        val code = JSONObject(String(Base64.decode(requireNotNull(args.getString("pairCode")), Base64.DEFAULT), Charsets.UTF_8))
        val store = SecureStore(instrumentation.targetContext)
        val wrong = JSONObject(code.toString()).put("pin", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
        assertThrows(IllegalArgumentException::class.java) { LanClient(wrong, store) }
        val originalConnection = store.load()
        store.clear()
        lateinit var client: LanClient
        try {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val model = AtomicReference<StudyViewModel>()
            scenario.onActivity { it.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT; model.set(ViewModelProvider(it)[StudyViewModel::class.java]) }
            model.get().pair(code.toString())
            until("原生应用提交配对并在电脑批准后连接") { model.get().ui.value.connected }
            client = LanClient(JSONObject(requireNotNull(store.load())), store)
        assertEquals(1, client.json("/v1/hello", authorized = false).getInt("apiVersion"))
        val session = client.json("/v1/session")
        val note = client.json("/v1/notes/read", JSONObject().put("path", "测试笔记.md"))
        if (args.getString("stage4") == "true") {
            kotlinx.coroutines.runBlocking { model.get().openNote("测试笔记.md").join() }
            java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "drop-request").writeText("ready")
            until("服务断线后进入缓存阅读") { !model.get().ui.value.connected && model.get().ui.value.offline }
            kotlinx.coroutines.runBlocking { model.get().openNote("测试笔记.md").join() }
            assertTrue(model.get().ui.value.note!!.getString("content").contains("传递函数"))
            until("mDNS 更新端口后自动重连") { model.get().ui.value.connected }
            client.close(); client = LanClient(JSONObject(requireNotNull(store.load())), store)
        }
        assertTrue(note.getString("content").contains("传递函数"))
        val link = client.json("/v1/notes/resolve", JSONObject().put("base", "测试笔记.md").put("target", "相关笔记").put("wiki", true))
        assertEquals("相关笔记.md", link.getString("path"))
        val chat = client.json("/v1/conversations")
        val id = UUID.randomUUID().toString()
        val request = JSONObject().put("requestId", id).put("conversationId", chat.getString("conversationId")).put("text", "请解释传递函数")
            .put("context", JSONObject().put("resources", JSONArray().put(JSONObject().put("kind", "note").put("vaultId", session.getString("vaultId")).put("path", note.getString("path")).put("version", note.getString("version")))))
        client.json("/v1/chat/requests", request)
        client.json("/v1/chat/requests", request)
        until { val task = client.json("/v1/chat/requests/$id"); assertNotEquals(task.optString("message"), "failed", task.optString("status")); task.optString("status") == "complete" }
        val answer = client.json("/v1/conversations").getJSONArray("messages")
        assertTrue(answer.getJSONObject(answer.length() - 1).getString("text").contains("传递函数"))
            until("原生界面连接电脑") { model.get().ui.value.connected }
            val previousConversation = model.get().ui.value.chat.getString("conversationId")
            kotlinx.coroutines.runBlocking { model.get().conversation().join() }
            assertNotEquals("新会话必须有独立 ID", previousConversation, model.get().ui.value.chat.getString("conversationId"))
            kotlinx.coroutines.runBlocking { model.get().conversation(previousConversation).join() }
            assertEquals("历史会话能切换回原记录", previousConversation, model.get().ui.value.chat.getString("conversationId"))
            kotlinx.coroutines.runBlocking { model.get().search("传递函数").join() }
            assertTrue("平板全文检索必须找到内容匹配笔记", model.get().ui.value.notes.any { it.path == "测试笔记.md" })
            kotlinx.coroutines.runBlocking { model.get().search("").join() }
            model.get().openNote("测试笔记.md")
            until { model.get().ui.value.note?.optString("path") == "测试笔记.md" }
            scenario.onActivity { model.get().pauseConnection() }
            kotlinx.coroutines.runBlocking { model.get().openNote("测试笔记.md").join() }
            assertTrue(model.get().ui.value.offline)
            assertTrue(model.get().ui.value.note!!.getString("content").contains("传递函数"))
            scenario.onActivity { model.get().resume() }
            until("从离线阅读恢复真实 TLS 连接") { model.get().ui.value.connected }
            model.get().draft("从平板界面解释这篇笔记")
            model.get().send()
            until("平板 ViewModel 流式回答") {
                val messages = model.get().ui.value.chat.optJSONArray("messages") ?: return@until false
                val hasQuestion = (0 until messages.length()).any { messages.getJSONObject(it).optString("text") == "从平板界面解释这篇笔记" }
                hasQuestion && messages.getJSONObject(messages.length() - 1).optString("status") == "complete"
            }
            model.get().openNote("测试笔记.md")
            until { model.get().ui.value.selectedTab == 0 }
            var rendered = false
            try { until("WebView 真实中文、KaTeX 与 Mermaid") {
                val latch = CountDownLatch(1)
                scenario.onActivity { activity ->
                    val readers = views(activity.window.decorView).filter { it.tag == "study-note" }
                    if (readers.isEmpty()) latch.countDown()
                    else readers.first().evaluateJavascript("JSON.stringify({formula:document.querySelectorAll('.katex').length,text:document.body.innerText,diagram:[...document.querySelectorAll('.diagram-image')].some(i=>i.complete&&i.naturalWidth>0),image:[...document.querySelectorAll('.note-image img')].some(i=>i.complete&&i.naturalWidth>0&&i.src.startsWith('https://appassets.androidplatform.net/resource/'))})") { result ->
                        rendered = runCatching { val payload = JSONObject(org.json.JSONTokener(result).nextValue() as String); payload.optInt("formula") > 0 && payload.optString("text").contains("传递函数") && payload.optBoolean("diagram") && payload.optBoolean("image") }.getOrDefault(false)
                        latch.countDown()
                    }
                }
                latch.await(3, TimeUnit.SECONDS); rendered
            } } catch (failure: Exception) {
                runCatching { flushReaders(scenario) }
                capture("reader-failure.png")
                throw failure
            }
            assertTrue("本地 React/KaTeX 阅读内容必须真实出现在 Android WebView", rendered)
            capture("learning-stage2.png", flushReaders(scenario))
            scenario.onActivity { activity -> views(activity.window.decorView).first { it.tag == "study-note" }.evaluateJavascript("document.querySelector('a.note-internal-link').click()", null) }
            until("点击双链后通过电脑读取目标笔记") { model.get().ui.value.note?.optString("path") == "相关笔记.md" }
            kotlinx.coroutines.runBlocking { model.get().openNote("测试笔记.md").join() }
            scenario.onActivity { it.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            until("横屏阅读区") {
                var landscape = false
                scenario.onActivity { landscape = it.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE }
                landscape
            }
            until("横屏笔记完成排版") {
                val latch = CountDownLatch(1); var ok = false
                scenario.onActivity { activity ->
                    val reader = views(activity.window.decorView).firstOrNull { it.tag == "study-note" }
                    if (reader == null) latch.countDown()
                    else reader.evaluateJavascript("document.querySelectorAll('.katex').length") { value -> ok = value.toIntOrNull()?.let { it > 0 } == true; latch.countDown() }
                }
                latch.await(3, TimeUnit.SECONDS); ok
            }
            until("横屏对话自动跟随最新回答") {
                val latch = CountDownLatch(1); var atEnd = false
                scenario.onActivity { activity ->
                    val reader = views(activity.window.decorView).firstOrNull { it.tag == "study-conversation" }
                    if (reader == null) latch.countDown()
                    else reader.evaluateJavascript("(()=>{const e=document.querySelector('.note-preview-scroll');const p=document.querySelector('.note-preview');return !!e&&p.dataset.compiling==='false'&&Number(p.dataset.blockCount)>0&&e.scrollHeight>e.clientHeight&&e.scrollHeight-e.scrollTop-e.clientHeight<80})()") { value -> atEnd = value == "true"; latch.countDown() }
                }
                latch.await(3, TimeUnit.SECONDS); atEnd
            }
            capture("learning-stage2-landscape.png", flushReaders(scenario))
            val mediaId = args.getString("mediaId")
            if (args.getString("stage3") == "true" && !mediaId.isNullOrBlank()) {
                try {
                    productPlayer(scenario, model.get(), client, mediaId, "local")
                    val course = args.getString("courseId")
                    if (!course.isNullOrBlank()) productPlayer(scenario, model.get(), client, course, "bilibili")
                    scenario.onActivity { model.get().playback.pause() }
                } catch (e: Throwable) {
                    capture("player-failure.png")
                    java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "player-failure.txt").writeText(model.get().playback.ui.value.toString() + "\n" + runCatching { compose.onRoot().printToString() }.getOrDefault("无法读取语义树"))
                    throw e
                }
            }
            if (!mediaId.isNullOrBlank()) {
                val ready = CountDownLatch(1); val failure = AtomicReference<String?>(null)
                val proof = AtomicReference<androidx.media3.ui.PlayerView>(); val playing = AtomicReference<ExoPlayer>()
                scenario.onActivity { activity ->
                    val player = ExoPlayer.Builder(activity).setMediaSourceFactory(DefaultMediaSourceFactory(activity).setDataSourceFactory(client.mediaDataSource())).build()
                    val playerView = androidx.media3.ui.PlayerView(activity).apply { this.player = player }
                    (activity.window.decorView as ViewGroup).addView(playerView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    proof.set(playerView); playing.set(player)
                    player.addListener(object : Player.Listener {
                        override fun onRenderedFirstFrame() { player.pause(); ready.countDown() }
                        override fun onPlayerError(error: androidx.media3.common.PlaybackException) { failure.set(error.toString()); ready.countDown() }
                    })
                    player.setMediaItem(MediaItem.fromUri(client.url("/v1/media/$mediaId"))); player.prepare(); player.play()
                }
                try {
                    assertTrue("Media3 必须在真实视图渲染 HTTPS 视频首帧", ready.await(20, TimeUnit.SECONDS)); assertNull(failure.get())
                    capture("video-stage0.png")
                } finally {
                    scenario.onActivity { (proof.get().parent as? ViewGroup)?.removeView(proof.get()); playing.get().release() }
                }
            }
            val courseId = args.getString("courseId")
            if (!courseId.isNullOrBlank()) {
                val descriptor = client.json("/v1/media/$courseId/prepare", JSONObject())
                assertEquals("真实课程需要独立音视频轨道", "separate", descriptor.getString("kind"))
                assertEquals(2, descriptor.getJSONArray("tracks").length())
                val ready = CountDownLatch(1); val audioReady = CountDownLatch(1); val failure = AtomicReference<String?>(null)
                val proof = AtomicReference<androidx.media3.ui.PlayerView>(); val playing = AtomicReference<ExoPlayer>()
                scenario.onActivity { activity ->
                    val player = ExoPlayer.Builder(activity).build()
                    val playerView = androidx.media3.ui.PlayerView(activity).apply { this.player = player }
                    (activity.window.decorView as ViewGroup).addView(playerView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    proof.set(playerView); playing.set(player)
                    player.addListener(object : Player.Listener {
                        override fun onRenderedFirstFrame() { ready.countDown() }
                        override fun onPlayerError(error: androidx.media3.common.PlaybackException) { failure.set(error.toString()); ready.countDown(); audioReady.countDown() }
                    })
                    player.addAnalyticsListener(object : androidx.media3.exoplayer.analytics.AnalyticsListener {
                        override fun onAudioPositionAdvancing(eventTime: androidx.media3.exoplayer.analytics.AnalyticsListener.EventTime, playoutStartSystemTimeMs: Long) { audioReady.countDown() }
                    })
                    player.setMediaSource(client.mediaSource(descriptor)); player.prepare(); player.play()
                }
                try {
                    assertTrue("真实 B站课程需渲染视频首帧", ready.await(30, TimeUnit.SECONDS)); assertNull(failure.get())
                    assertTrue("真实 B站音轨需进入音频输出时钟", audioReady.await(20, TimeUnit.SECONDS)); assertNull(failure.get())
                    var proofJson = JSONObject()
                    until("真实课程音视频持续解码") {
                        var decoded = false
                        scenario.onActivity {
                            val player = playing.get(); val audio = player.audioDecoderCounters; val video = player.videoDecoderCounters
                            proofJson = JSONObject().put("positionMs", player.currentPosition).put("audioBuffers", audio?.renderedOutputBufferCount ?: 0).put("videoFrames", video?.renderedOutputBufferCount ?: 0).put("audioInput", player.audioFormat?.sampleMimeType).put("videoInput", player.videoFormat?.sampleMimeType)
                            decoded = player.currentPosition >= 3000 && (audio?.renderedOutputBufferCount ?: 0) > 10 && (video?.renderedOutputBufferCount ?: 0) > 10
                        }
                        decoded
                    }
                    scenario.onActivity { playing.get().pause() }
                    java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "course-stage0.json").writeText(proofJson.toString(2))
                    capture("course-stage0.png")
                } finally { scenario.onActivity { (proof.get().parent as? ViewGroup)?.removeView(proof.get()); playing.get().release() } }
            }
        }
        client.close()
        } finally { if (originalConnection != null) store.save(originalConnection) else store.clear() }
    }
}
