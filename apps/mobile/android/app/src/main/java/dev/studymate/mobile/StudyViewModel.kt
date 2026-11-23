package dev.studymate.mobile

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class NoteRow(val path: String, val name: String, val snippet: String = "")

data class NoteTreeNode(
    val path: String,
    val name: String,
    val isDirectory: Boolean,
    val children: List<NoteTreeNode> = emptyList(),
)

data class NoteHistoryEntry(val path: String, val anchor: String = "")

data class StudyUi(
    val offline: Boolean = false,
    val connected: Boolean = false,
    val working: Boolean = false,
    val status: String = "连接电脑，接续学习",
    val error: String = "",
    val notes: List<NoteRow> = emptyList(),
    val noteTree: List<NoteTreeNode> = emptyList(),
    val note: JSONObject? = null,
    val sideNote: JSONObject? = null,
    val openTabs: List<String> = emptyList(),
    val sideTabs: List<String> = emptyList(),
    val canBack: Boolean = false,
    val canForward: Boolean = false,
    val showHome: Boolean = false,
    val videoDocked: Boolean = false,
    val vaultId: String = "",
    val chat: JSONObject = JSONObject(),
    val draft: String = "",
    val pendingRequest: String? = null,
    val model: String = "",
    val selectedTab: Int = 0,
    val computers: List<DiscoveredComputer> = emptyList(),
    val videos: List<JSONObject> = emptyList(),
    val questionVideo: RemoteVideoRef? = null,
    val inkSyncNonce: Int = 0,
)

class StudyViewModel(application: Application) : AndroidViewModel(application) {
    private val store = SecureStore(application)
    private val inkStore = NoteInkStore(application)
    internal val offlineLibrary = OfflineLibrary(application)
    private val discovery = ComputerDiscovery(application) { computer ->
        client?.updateAddress(computer)
        state.update { it.copy(computers = (it.computers.filterNot { old -> old.id == computer.id } + computer)) }
    }
    private val state = MutableStateFlow(StudyUi())
    val ui = state.asStateFlow()
    var client: LanClient? = null; private set
    val playback = TabletPlayback(application, viewModelScope) { client }
    private var socket: WebSocket? = null
    private var socketGeneration = 0L
    private var lastSequence = 0L
    private var reconnect: Job? = null
    private var silentSyncJob: Job? = null
    private var session = JSONObject()
    private var recent: RecentCache? = null
    private var stopped = false
    private val noteGeneration = java.util.concurrent.atomic.AtomicLong()
    private val searchGeneration = java.util.concurrent.atomic.AtomicLong()
    private val noteCache = ConcurrentHashMap<String, JSONObject>()
    private val history = mutableListOf<NoteHistoryEntry>()
    private var historyCursor = -1
    @Volatile private var pendingSubmission: JSONObject? = null

    init {
        viewModelScope.launch { offlineLibrary.initialize() }
        viewModelScope.launch {
            while (isActive) {
                delay(20_000)
                if (state.value.connected) client?.let { offlineLibrary.syncLan(it) }
            }
        }
        viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(5000)
                val snapshot = state.value
                if (snapshot.connected) runCatching {
                    recent?.get("snapshot")?.let { recent?.put("snapshot", it.put("chat", snapshot.chat)) }
                }
            }
        }
    }

    fun resume() {
        stopped = false
        discovery.start()
        if (client != null) {
            if (socket == null) connect()
            return
        }
        runCatching { store.load() }
            .onSuccess { saved -> if (saved != null) connectSaved(saved) }
            .onFailure { state.update { it.copy(error = "已保存的连接无法解密，请重新配对。") } }
    }

    private fun connectSaved(saved: String) = work {
        client = LanClient(JSONObject(saved), store)
        val c = requireNotNull(client).connection
        if (c.has("vaultId")) {
            recent = RecentCache(getApplication(), c.getString("serverId") + c.optString("deviceId") + c.getString("vaultId"))
            recent?.get("snapshot")?.let { cached ->
                val notesArray = cached.getJSONArray("notes")
                state.update {
                    it.copy(
                        offline = true,
                        vaultId = c.getString("vaultId"),
                        notes = flatten(notesArray),
                        noteTree = buildTree(notesArray),
                        chat = cached.getJSONObject("chat"),
                        status = "离线阅读 · 显示上次缓存，问答需连接电脑",
                    )
                }
            }
            pendingSubmission = recent?.get("pending")
            state.update { it.copy(pendingRequest = pendingSubmission?.optString("requestId")) }
        }
        try {
            connectNow()
        } catch (e: RemoteApiException) {
            if (e.code in listOf("UNPAIRED", "STALE_VAULT", "PERMISSION_DENIED")) {
                recent?.clear()
                clearNoteDeskState()
                state.value = StudyUi()
            }
            throw e
        }
    }

    fun pair(raw: String) = work {
        stopped = false
        val code = JSONObject(raw)
        withContext(Dispatchers.Main) { playback.clear() }
        client?.close(); socket?.cancel(); socket = null; lastSequence = 0
        val next = LanClient(code, store)
        val hello = next.json("/v1/hello", authorized = false)
        require(hello.getInt("apiVersion") == 1) { "电脑协议版本不兼容，请更新应用。" }
        val request = next.json("/v1/pair", PairSubmit(secret = code.getString("secret"), name = android.os.Build.MODEL).toJson(), false)
        state.update { it.copy(status = "请在电脑的平板连接页面允许配对") }
        var accepted: JSONObject? = null
        for (attempt in 0 until 180) {
            delay(1000)
            val status = next.json("/v1/pair/status", PairPoll(pairingId = request.getString("pairingId"), pollToken = request.getString("pollToken")).toJson(), false)
            when (status.getString("status")) {
                "rejected" -> error("电脑拒绝了配对申请。")
                "approved" -> {
                    accepted = status
                    break
                }
            }
        }
        val credentials = accepted ?: error("配对申请已超时，请重新扫描。")
        next.acceptCredentials(credentials); recent?.clear(); pendingSubmission = null
        clearNoteDeskState()
        state.value = StudyUi(working = true)
        client = next; connectNow()
    }

    private fun connect() = work { connectNow() }

    private fun connectNow() {
        val previous = client ?: return
        val remote = if (!state.value.connected) LanClient(JSONObject(previous.connection.toString()), store).also { client = it; previous.close() } else previous
        require(remote.json("/v1/hello", authorized = false).getInt("apiVersion") == 1) { "电脑协议版本不兼容，请更新应用。" }
        session = remote.json("/v1/session")
        val vault = session.getString("vaultId")
        val tree = remote.json("/v1/notes").getJSONArray("notes")
        if (state.value.vaultId.isNotBlank() && state.value.vaultId != vault) {
            recent?.clear()
            clearNoteDeskState()
            state.update { it.copy(note = null, sideNote = null, openTabs = emptyList(), sideTabs = emptyList(), canBack = false, canForward = false) }
        }
        recent = RecentCache(getApplication(), remote.connection.getString("serverId") + remote.connection.optString("deviceId") + vault)
        remote.connection.put("vaultId", vault); store.save(remote.connection.toString())
        recent?.put("snapshot", JSONObject().put("notes", tree).put("chat", session.getJSONObject("chat")))
        state.update {
            it.copy(
                offline = false,
                connected = true,
                vaultId = vault,
                notes = flatten(tree),
                noteTree = buildTree(tree),
                chat = session.getJSONObject("chat"),
                model = session.getJSONObject("chat").optString("model"),
                status = "已连接电脑 · 只读学习",
                error = "",
            )
        }
        viewModelScope.launch { if (!stopped) playback.foreground() }
        openEvents()
        viewModelScope.launch {
            offlineLibrary.syncLan(remote)
            syncAllNoteInk(remote, vault)
        }
        refreshVideos()
        state.value.pendingRequest?.let { id ->
            val task = runCatching { remote.json("/v1/chat/requests/$id") }.getOrNull()
            if (task != null) finishRequest(task)
        }
    }

    private fun flatten(rows: JSONArray): List<NoteRow> = buildList {
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            if (row.has("children")) addAll(flatten(row.getJSONArray("children")))
            else add(NoteRow(row.getString("path"), row.optString("name", row.getString("path"))))
        }
    }

    private fun buildTree(rows: JSONArray): List<NoteTreeNode> = buildList {
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            val path = row.getString("path")
            val name = row.optString("name", path)
            if (row.has("children")) {
                add(NoteTreeNode(path, name, isDirectory = true, children = buildTree(row.getJSONArray("children"))))
            } else {
                add(NoteTreeNode(path, name, isDirectory = false))
            }
        }
    }

    private fun clearNoteDeskState() {
        noteCache.clear()
        synchronized(history) {
            history.clear()
            historyCursor = -1
        }
    }

    private suspend fun syncAllNoteInk(remote: LanClient, vaultId: String) = withContext(Dispatchers.IO) {
        if (vaultId.isBlank()) return@withContext
        runCatching {
            val scopes = (listOf(vaultId) + offlineLibrary.sourcesForVault(vaultId)).distinct()
            val localNotes = inkStore.listScopePadsJson(scopes)
            val result = remote.json("/v1/notes/ink/sync-all", NoteInkSyncAll(notes = localNotes).toJson())
            val mergedNotes = result.optJSONObject("notes") ?: return@runCatching
            val keys = mergedNotes.keys()
            var anyUpdated = false
            while (keys.hasNext()) {
                val notePath = keys.next()
                val remotePads = mergedNotes.optJSONArray(notePath) ?: continue
                val before = inkStore.load(vaultId, notePath, "").optJSONArray("pads")?.toString() ?: "[]"
                val after = inkStore.mergePads(vaultId, notePath, remotePads).toString()
                if (after != before) anyUpdated = true
            }
            if (anyUpdated) {
                state.update { it.copy(inkSyncNonce = it.inkSyncNonce + 1) }
            }
        }
    }

    private fun openEvents() {
        val generation = ++socketGeneration
        socket?.cancel()
        socket = client?.events(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (generation != socketGeneration) {
                    webSocket.cancel(); return
                }
                if (lastSequence > 0) webSocket.send(JSONObject().put("after", lastSequence).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (generation != socketGeneration) return
                runCatching {
                    val event = JSONObject(text); val type = event.getString("type"); val sequence = event.optLong("sequence")
                    if (type == "connected") {
                        if (lastSequence == 0L) lastSequence = sequence; return
                    }
                    if (type == "reset") {
                        lastSequence = sequence; refreshChat(); return
                    }
                    if (sequence <= lastSequence) return
                    lastSequence = sequence
                    val data = event.optJSONObject("data") ?: return
                    when (type) {
                        "chat.snapshot" -> state.update { it.copy(chat = data, model = data.optString("model")) }
                        "chat.delta", "chat.message" -> mergeMessage(type, data)
                        "chat.status" -> state.update { old ->
                            val chat = JSONObject(old.chat.toString())
                            data.keys().forEach { key -> chat.put(key, data.get(key)) }
                            old.copy(chat = chat)
                        }
                        "request" -> if (data.optString("id") == state.value.pendingRequest) finishRequest(data)
                        "resources.changed" -> if (data.optString("vaultId") != state.value.vaultId) {
                            state.update { it.copy(error = "电脑已切换知识库，请在电脑重新授权后连接。") }
                        } else {
                            refreshOpenNotesSilently()
                        }
                        "ink.changed" -> if (data.optString("vaultId") == state.value.vaultId) {
                            state.update { it.copy(inkSyncNonce = it.inkSyncNonce + 1) }
                        }
                    }
                }.onFailure { refreshChat() }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (generation == socketGeneration) scheduleReconnect(reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (generation == socketGeneration) scheduleReconnect("连接暂时中断，正在重连…")
            }
        })
    }

    private fun mergeMessage(type: String, data: JSONObject) {
        var reload = false
        state.update { old ->
            if (data.optString("conversationId") != old.chat.optString("conversationId")) {
                reload = true; return@update old
            }
            val chat = JSONObject(old.chat.toString()); val messages = chat.optJSONArray("messages") ?: JSONArray()
            val index = (0 until messages.length()).firstOrNull { messages.getJSONObject(it).getString("id") == data.getString("id") }
            val message = JSONObject(data.toString())
            if (type == "chat.delta") {
                if (index == null) {
                    reload = true; return@update old
                }
                val previous = messages.getJSONObject(index).optString("text")
                if (message.has("offset") && message.getInt("offset") != previous.length) {
                    reload = true; return@update old
                }
                message.put("text", previous + message.optString("append")); message.remove("append")
            }
            message.remove("conversationId"); message.remove("offset")
            if (index == null) messages.put(message) else messages.put(index, message)
            chat.put("messages", messages); old.copy(chat = chat)
        }
        if (reload) refreshChat()
    }

    private fun refreshChat() {
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { client?.json("/v1/conversations") }
                .onSuccess { chat -> if (chat != null) state.update { it.copy(chat = chat, model = chat.optString("model")) } }
        }
    }

    private fun scheduleReconnect(reason: String) {
        socket = null
        if (stopped || reconnect?.isActive == true) return
        viewModelScope.launch { playback.pause() }
        state.update { it.copy(offline = it.notes.isNotEmpty(), connected = false, status = "离线阅读 · 正在重连电脑") }
        reconnect = viewModelScope.launch(Dispatchers.IO) {
            var seconds = 1L
            while (!stopped && !state.value.connected) {
                delay(seconds * 1000)
                if (seconds >= 4) {
                    discovery.stop(); discovery.start()
                }
                runCatching { connectNow() }.onFailure { failure ->
                    if (failure is RemoteApiException && failure.code in listOf("UNPAIRED", "STALE_VAULT", "PERMISSION_DENIED")) {
                        recent?.clear(); stopped = true; clearNoteDeskState()
                        state.value = StudyUi(error = failure.message ?: "请重新授权电脑连接。")
                    } else {
                        state.update { old -> old.copy(error = "重连尚未成功，请检查电脑服务和 VPN 局域网设置。") }
                    }
                }
                seconds = (seconds * 2).coerceAtMost(15)
            }
        }
    }

    private fun work(block: suspend () -> Unit) = viewModelScope.launch(Dispatchers.IO) {
        state.update { it.copy(working = true, error = "") }
        try {
            block()
        } catch (e: Exception) {
            state.update {
                it.copy(
                    error = if (e is java.io.IOException && e !is RemoteApiException) {
                        "无法直连电脑：请检查电脑 Wi-Fi 网卡、防火墙，以及两端 VPN 是否允许局域网。"
                    } else {
                        e.message ?: "操作未完成，请重试。"
                    },
                )
            }
            if (e is java.io.IOException && e !is RemoteApiException && client != null) scheduleReconnect("正在重新连接电脑")
        } finally {
            state.update { it.copy(working = false) }
        }
    }

    private fun recordHistory(path: String, anchor: String) {
        synchronized(history) {
            val current = history.getOrNull(historyCursor)
            if (current?.path == path && current.anchor == anchor) return
            while (history.size > historyCursor + 1) history.removeAt(history.lastIndex)
            history.add(NoteHistoryEntry(path, anchor))
            if (history.size > 100) {
                history.removeAt(0)
            }
            historyCursor = history.lastIndex
        }
    }

    private fun historyFlags(): Pair<Boolean, Boolean> = synchronized(history) {
        (historyCursor > 0) to (historyCursor in 0 until history.lastIndex)
    }

    private fun applyOpenedNote(note: JSONObject, pane: String, anchor: String, record: Boolean) {
        val path = note.getString("path")
        val withAnchor = JSONObject(note.toString()).put("anchor", anchor)
        noteCache[path] = JSONObject(note.toString())
        if (pane == "main" && record) recordHistory(path, anchor)
        val (canBack, canForward) = historyFlags()
        state.update { old ->
            if (pane == "side") {
                val nextTabs = if (path in old.sideTabs) old.sideTabs else old.sideTabs + path
                old.copy(sideNote = withAnchor, sideTabs = nextTabs, canBack = canBack, canForward = canForward)
            } else {
                val nextTabs = if (path in old.openTabs) old.openTabs else old.openTabs + path
                old.copy(
                    note = withAnchor,
                    openTabs = nextTabs,
                    selectedTab = 0,
                    showHome = false,
                    canBack = canBack,
                    canForward = canForward,
                )
            }
        }
    }

    fun openNote(path: String): Job = openNoteInPane(path, "main", "", true)

    fun openNoteInPane(path: String, pane: String = "main", anchor: String = "", record: Boolean = true): Job {
        val generation = noteGeneration.incrementAndGet()
        return work {
            val note = if (state.value.connected) requireNotNull(client).json("/v1/notes/read", JSONObject().put("path", path))
            else recent?.get("note:$path") ?: noteCache[path] ?: error("此笔记尚未缓存，请连接电脑后打开。")
            if (state.value.connected) recent?.put("note:$path", note)
            withContext(Dispatchers.Main) {
                if (generation == noteGeneration.get()) {
                    if (pane == "main") playback.pause()
                    applyOpenedNote(note, pane, anchor, record)
                }
            }
        }
    }

    fun selectTab(path: String, pane: String = "main") {
        val cached = noteCache[path] ?: recent?.get("note:$path")
        if (cached != null) {
            if (pane == "main") playback.pause()
            applyOpenedNote(cached, pane, "", pane == "main")
        } else {
            openNoteInPane(path, pane, "", pane == "main")
        }
    }

    fun closeTab(path: String, pane: String = "main") {
        state.update { old ->
            if (pane == "side") {
                val idx = old.sideTabs.indexOf(path)
                val tabs = old.sideTabs.filterNot { it == path }
                val activePath = if (old.sideNote?.optString("path") == path) tabs.getOrNull((idx - 1).coerceAtLeast(0)) else old.sideNote?.optString("path")
                val nextSide = activePath?.let { noteCache[it] ?: recent?.get("note:$it") }
                old.copy(sideTabs = tabs, sideNote = nextSide)
            } else {
                val idx = old.openTabs.indexOf(path)
                val tabs = old.openTabs.filterNot { it == path }
                val activePath = if (old.note?.optString("path") == path) tabs.getOrNull((idx - 1).coerceAtLeast(0)) else old.note?.optString("path")
                val nextMain = activePath?.let { noteCache[it] ?: recent?.get("note:$it") }
                old.copy(openTabs = tabs, note = nextMain)
            }
        }
    }

    fun refreshNote(pane: String = "main") {
        val target = if (pane == "side") state.value.sideNote?.optString("path") else state.value.note?.optString("path")
        if (!target.isNullOrBlank()) openNoteInPane(target, pane, "", false)
    }

    fun dockNote(path: String, fromPane: String) {
        val toPane = if (fromPane == "main") "side" else "main"
        val doc = noteCache[path] ?: (if (fromPane == "main") state.value.note else state.value.sideNote) ?: return
        state.update { old ->
            val mainTabs = if (fromPane == "main") old.openTabs.filterNot { it == path } else if (path in old.openTabs) old.openTabs else old.openTabs + path
            val sideTabs = if (fromPane == "side") old.sideTabs.filterNot { it == path } else if (path in old.sideTabs) old.sideTabs else old.sideTabs + path
            val mainActive = if (fromPane == "main") {
                if (old.note?.optString("path") == path) mainTabs.lastOrNull()?.let { noteCache[it] } else old.note
            } else doc
            val sideActive = if (fromPane == "side") {
                if (old.sideNote?.optString("path") == path) sideTabs.lastOrNull()?.let { noteCache[it] } else old.sideNote
            } else doc
            old.copy(
                openTabs = mainTabs,
                sideTabs = sideTabs,
                note = mainActive,
                sideNote = sideActive,
                selectedTab = if (toPane == "main") 0 else old.selectedTab,
                showHome = if (toPane == "main") false else old.showHome,
            )
        }
    }

    fun dockVideo(toSide: Boolean) {
        state.update { old ->
            if (toSide) {
                old.copy(
                    videoDocked = true,
                    selectedTab = if (old.note != null) 0 else old.selectedTab,
                )
            } else {
                old.copy(videoDocked = false, selectedTab = 3, showHome = false)
            }
        }
    }

    fun stepHistory(delta: Int) {
        val target = synchronized(history) {
            val next = historyCursor + delta
            if (next !in history.indices) return
            historyCursor = next
            history[next]
        }
        val cached = noteCache[target.path]
        if (cached != null) {
            playback.pause()
            applyOpenedNote(cached, "main", target.anchor, false)
        } else {
            openNoteInPane(target.path, "main", target.anchor, false)
        }
    }

    fun showWorkspaceHome() {
        playback.pause()
        state.update { it.copy(selectedTab = 0, showHome = true) }
    }

    fun navigate(base: String, target: String, wiki: Boolean): Job = navigateInPane(base, target, wiki, "main")

    fun navigateInPane(base: String, target: String, wiki: Boolean, pane: String = "main"): Job {
        val generation = noteGeneration.incrementAndGet()
        return work {
            val remote = requireNotNull(client)
            val result = remote.json("/v1/notes/resolve", JSONObject().put("base", base).put("target", target).put("wiki", wiki))
            val note = remote.json("/v1/notes/read", JSONObject().put("path", result.getString("path")))
            recent?.put("note:" + note.getString("path"), note)
            val anchor = result.optString("anchor")
            withContext(Dispatchers.Main) {
                if (generation == noteGeneration.get()) {
                    if (pane == "main") playback.pause()
                    applyOpenedNote(note, pane, anchor, pane == "main")
                }
            }
        }
    }

    fun search(query: String): Job {
        val generation = searchGeneration.incrementAndGet()
        return work {
            if (query.isBlank()) {
                val tree = requireNotNull(client).json("/v1/notes").getJSONArray("notes")
                val notes = flatten(tree)
                val builtTree = buildTree(tree)
                if (generation == searchGeneration.get()) {
                    state.update { it.copy(notes = notes.distinctBy { row -> row.path }, noteTree = builtTree) }
                }
            } else {
                val hits = requireNotNull(client).json("/v1/knowledge/search", JSONObject().put("query", query)).getJSONArray("hits")
                val notes = (0 until hits.length()).map {
                    val hit = hits.getJSONObject(it)
                    NoteRow(hit.getString("path"), hit.optString("name", hit.getString("path")), hit.optString("snippet"))
                }
                if (generation == searchGeneration.get()) {
                    state.update { it.copy(notes = notes.distinctBy { row -> row.path }) }
                }
            }
        }
    }

    fun refreshVideos() = work {
        val videos = requireNotNull(client).json("/v1/videos").getJSONArray("videos")
        state.update { it.copy(videos = (0 until videos.length()).map { i -> videos.getJSONObject(i) }) }
    }

    fun openVideo(row: JSONObject, fromComputer: Boolean = false) {
        if (fromComputer) {
            work {
                val videos = requireNotNull(client).json("/v1/videos").getJSONArray("videos")
                val rows = (0 until videos.length()).map { videos.getJSONObject(it) }
                state.update { it.copy(videos = rows) }
                val current = rows.firstOrNull { it.getString("id") == row.getString("id") } ?: error("课程已从电脑移除，请刷新列表。")
                withContext(Dispatchers.Main) { startVideo(current, true) }
            }
        } else {
            startVideo(row, false)
        }
    }

    private fun startVideo(row: JSONObject, fromComputer: Boolean) {
        val desktop = if (fromComputer) row.optJSONObject("desktop") else null
        playback.open(row.getString("id"), row.getString("title"), desktop?.optDouble("position"), desktop?.optDouble("rate")?.toFloat())
        state.update { it.copy(selectedTab = 3, showHome = false, videoDocked = false) }
    }

    fun continueLearning() = work {
        val latest = requireNotNull(client).json("/v1/session"); session = latest
        val id = latest.optString("sourceId")
        val videos = requireNotNull(client).json("/v1/videos").getJSONArray("videos")
        val rows = (0 until videos.length()).map { videos.getJSONObject(it) }
        state.update { it.copy(videos = rows) }
        val row = rows.firstOrNull { it.optString("id") == id && it.optBoolean("supported") }
        if (row != null) {
            withContext(Dispatchers.Main) { startVideo(row, true) }
        } else {
            val path = latest.optString("note").takeIf { it.isNotBlank() && it != "null" }
            if (path != null) openNote(path) else withContext(Dispatchers.Main) { tab(1) }
        }
    }

    fun askVideo() {
        val ref = playback.reference() ?: return
        playback.pause(); playback.fullscreen(false)
        state.update { it.copy(questionVideo = ref, selectedTab = 1) }
    }

    fun clearVideoQuestion() {
        state.update { it.copy(questionVideo = null) }
    }

    private fun refreshOpenNotesSilently() {
        silentSyncJob?.cancel()
        silentSyncJob = viewModelScope.launch(Dispatchers.IO) {
            delay(250)
            val remote = client ?: return@launch
            if (!state.value.connected) return@launch
            val mainNote = state.value.note
            val sideNote = state.value.sideNote
            if (mainNote != null) {
                val path = mainNote.optString("path")
                if (path.isNotBlank()) {
                    runCatching { remote.json("/v1/notes/read", JSONObject().put("path", path)) }
                        .onSuccess { fresh ->
                            val changed = fresh.optString("version") != mainNote.optString("version") ||
                                fresh.optString("content") != mainNote.optString("content")
                            if (changed) {
                                recent?.put("note:$path", fresh)
                                noteCache[path] = JSONObject(fresh.toString())
                                val updated = JSONObject(fresh.toString()).put("anchor", "")
                                state.update { old ->
                                    if (old.note?.optString("path") == path) old.copy(note = updated) else old
                                }
                            }
                        }
                }
            }
            if (sideNote != null) {
                val path = sideNote.optString("path")
                if (path.isNotBlank() && path != mainNote?.optString("path")) {
                    runCatching { remote.json("/v1/notes/read", JSONObject().put("path", path)) }
                        .onSuccess { fresh ->
                            val changed = fresh.optString("version") != sideNote.optString("version") ||
                                fresh.optString("content") != sideNote.optString("content")
                            if (changed) {
                                recent?.put("note:$path", fresh)
                                noteCache[path] = JSONObject(fresh.toString())
                                val updated = JSONObject(fresh.toString()).put("anchor", "")
                                state.update { old ->
                                    if (old.sideNote?.optString("path") == path) old.copy(sideNote = updated) else old
                                }
                            }
                        }
                } else if (path.isNotBlank()) {
                    noteCache[path]?.let { cached ->
                        val updated = JSONObject(cached.toString()).put("anchor", "")
                        state.update { old ->
                            if (old.sideNote?.optString("path") == path) old.copy(sideNote = updated) else old
                        }
                    }
                }
            }
        }
    }

    fun clearRecent() {
        playback.pause()
        clearNoteDeskState()
        work {
            recent?.clear()
            VideoBuffer.clear(getApplication())
            NoteInkStore(getApplication()).clearAllTempInk()
            state.update { it.copy(error = "近期笔记、临时手写、对话和视频缓冲已清除（手写栏已保留）。") }
        }
    }

    fun updateEndpoint(value: String) = work {
        val parts = value.trim().split(":")
        require(parts.size == 2 && parts[0].matches(Regex("(10|192\\.168|172\\.(1[6-9]|2[0-9]|3[01]))\\..*")) && parts[1].toInt() in 1..65535) {
            "请输入电脑 Wi-Fi 的 IPv4 地址:端口。"
        }
        val remote = requireNotNull(client) { "请先扫描配对二维码。" }
        remote.updateAddress(DiscoveredComputer(remote.connection.getString("serverId"), "电脑", listOf(parts[0]), parts[1].toInt()))
        connectNow()
    }

    fun draft(value: String) {
        state.update { it.copy(draft = value) }
    }

    fun tab(value: Int) {
        if (value != 3 && !state.value.videoDocked) playback.pause()
        state.update { it.copy(selectedTab = value, showHome = false) }
    }

    fun send() = work {
        val old = state.value
        require(old.connected) { "离线期间不能发送问题，请先连接电脑。" }
        require(old.draft.isNotBlank() && !old.chat.optBoolean("busy") && old.pendingRequest == null) { "请先确认上一条问题的发送状态。" }
        val id = UUID.randomUUID().toString(); val resources = mutableListOf<RemoteResourceRef>()
        (old.note ?: old.sideNote)?.let {
            resources.add(RemoteNoteRef(vaultId = old.vaultId, path = it.getString("path"), version = it.getString("version")))
        }
        old.questionVideo?.let { resources.add(it) }
        val input = ChatSubmit(requestId = id, conversationId = old.chat.getString("conversationId"), text = old.draft, context = ClientStudyContext(resources)).toJson()
        pendingSubmission = input
        recent?.put("pending", input)
        state.update { it.copy(pendingRequest = id) }
        requireNotNull(client).json("/v1/chat/requests", input)
        state.update { it.copy(draft = "", selectedTab = 1, questionVideo = null) }; refreshChat()
    }

    private fun finishRequest(task: JSONObject) {
        if (task.optString("status") !in listOf("complete", "failed", "cancelled", "interrupted")) return
        val original = pendingSubmission?.optString("text").orEmpty()
        pendingSubmission = null
        recent?.remove("pending")
        state.update {
            it.copy(
                pendingRequest = null,
                error = task.optString("message"),
                draft = if (task.optString("status") == "failed" && it.draft.isBlank()) original else it.draft,
            )
        }
    }

    fun retryPending() = work {
        val input = pendingSubmission ?: error("请重新查看当前会话记录，再决定是否发送新问题。")
        val remote = requireNotNull(client)
        val task = try {
            remote.json("/v1/chat/requests/" + input.getString("requestId"))
        } catch (error: RemoteApiException) {
            if (error.code == "NOT_FOUND") remote.json("/v1/chat/requests", input) else throw error
        }
        state.update { it.copy(draft = "") }
        finishRequest(task); refreshChat()
    }

    fun cancel() = work {
        state.value.pendingRequest?.let { requireNotNull(client).json("/v1/chat/requests/$it/cancel", JSONObject()) }
    }

    fun conversation(id: String? = null) = work {
        val request = JSONObject().put("operation", if (id == null) "create" else "switch")
        if (id != null) request.put("id", id)
        val chat = requireNotNull(client).json("/v1/conversations", request)
        state.update { it.copy(chat = chat) }
    }

    fun pauseConnection() {
        playback.stopForBackground(); stopped = true; discovery.stop()
        state.update { it.copy(connected = false, offline = it.notes.isNotEmpty()) }
        socketGeneration++; reconnect?.cancel(); socket?.close(1000, "后台暂停"); socket = null
    }

    fun disconnect() {
        playback.clear(); stopped = true; discovery.stop(); socketGeneration++; reconnect?.cancel()
        socket?.cancel(); socket = null; client?.close(); client = null
        recent?.clear(); store.clear(); clearNoteDeskState()
        state.value = StudyUi()
        viewModelScope.launch { offlineLibrary.forgetLan() }
    }

    override fun onCleared() {
        playback.clear(); stopped = true; discovery.stop(); socket?.cancel(); client?.close()
        super.onCleared()
    }
}
