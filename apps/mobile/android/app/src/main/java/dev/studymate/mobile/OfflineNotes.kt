package dev.studymate.mobile

import android.accounts.Account
import android.app.Application
import android.content.Context
import android.util.AtomicFile
import android.util.Base64
import android.webkit.WebResourceResponse
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.TimeUnit

private const val LIMIT = 24L * 1024 * 1024
private const val INK_DRIVE_LIMIT = 16L * 1024 * 1024
private const val DRIVE = "https://www.googleapis.com/drive/v3"
private const val DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3"
private val sourcePattern = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
private val filePattern = Regex("study-mate-notes-v1-(${sourcePattern.pattern})\\.json")
private val imageTypes = setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp")

internal data class OfflineNote(val source: String, val path: String)
internal data class OfflineUi(
    val notes: List<OfflineNote> = emptyList(),
    val email: String = "",
    val lanStatus: String = "",
    val driveStatus: String = "",
    val inkSyncNonce: Int = 0,
)

internal class OfflineLibrary(app: Application) {
    private val inkStore = NoteInkStore(app)
    private val crypto = SecureStore(app, "offline-notes")
    private val lanFile = AtomicFile(File(app.noBackupFilesDir, "offline-lan"))
    private val driveFile = AtomicFile(File(app.noBackupFilesDir, "offline-drive"))
    private val lock = Mutex()
    private val cloud = OkHttpClient.Builder().followRedirects(false).callTimeout(35, TimeUnit.SECONDS).build()
    private var lan = JSONObject()
    private var drive = JSONObject()
    private var ready = false
    @Volatile private var copies: Map<String, JSONObject> = emptyMap()
    @Volatile private var lanVaultBySource: Pair<String, String>? = null
    @Volatile private var accountEpoch = 0L
    private val state = MutableStateFlow(OfflineUi())
    val ui = state.asStateFlow()

    private fun load(file: AtomicFile): JSONObject {
        return try { JSONObject(crypto.decrypt(file.readFully()).toString(Charsets.UTF_8)) }
        catch (_: java.io.FileNotFoundException) { JSONObject() }
    }

    private fun save(file: AtomicFile, value: JSONObject) {
        val bytes = crypto.encrypt(value.toString().toByteArray())
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }

    suspend fun initialize() = withContext(Dispatchers.IO) {
        lock.withLock {
            if (ready) return@withLock
            lan = runCatching { load(lanFile) }.getOrElse {
                state.update { it.copy(lanStatus = "局域网离线副本无法读取，请重新同步") }; JSONObject()
            }
            drive = runCatching { load(driveFile) }.getOrElse {
                state.update { it.copy(driveStatus = "Drive 离线副本无法读取，请重新连接") }; JSONObject()
            }
            ready = true
            publish()
        }
    }

    private fun publish() {
        val next = mutableMapOf<String, JSONObject>()
        val cloudCopies = drive.optJSONObject("copies")
        cloudCopies?.keys()?.forEach { key -> next[key] = cloudCopies.getJSONObject(key) }
        lan.optJSONObject("snapshot")?.let { snapshot ->
            val key = snapshot.getString("source")
            if (snapshot.getLong("revision") >= (next[key]?.getLong("revision") ?: 0)) next[key] = snapshot
            val vault = lan.optString("identity").substringAfterLast('/', "")
            lanVaultBySource = if (vault.isNotBlank()) key to vault else null
        } ?: run { lanVaultBySource = null }
        copies = next
        val rows = next.flatMap { (source, copy) ->
            val notes = copy.getJSONArray("notes")
            (0 until notes.length()).map { OfflineNote(source, notes.getJSONObject(it).getString("path")) }
        }.sortedWith(compareBy({ it.path }, { it.source }))
        state.update { it.copy(notes = rows, email = drive.optString("email")) }
    }

    private fun validate(snapshot: JSONObject, source: String = snapshot.getString("source")): JSONObject {
        require(snapshot.getInt("schema") == 1 && sourcePattern.matches(source) && snapshot.getString("source") == source)
        require(snapshot.getLong("revision") > 0)
        val notes = snapshot.getJSONArray("notes")
        require(notes.length() <= 100)
        val paths = mutableSetOf<String>()
        for (i in 0 until notes.length()) {
            val note = notes.getJSONObject(i)
            require(note.getString("path").length in 1..500 && paths.add(note.getString("path")))
            note.getString("content")
            note.getJSONObject("images")
            note.getJSONObject("links")
        }
        val images = snapshot.getJSONObject("images")
        for (key in images.keys()) {
            val image = images.getJSONObject(key)
            require(image.getString("mime") in imageTypes)
            image.getString("data")
        }
        return snapshot
    }

    private fun read(response: Response, limit: Long): JSONObject = response.use {
        check(it.isSuccessful) { "同步请求失败（HTTP ${it.code}）" }
        val body = requireNotNull(it.body)
        require(body.contentLength() <= limit) { "同步内容超过容量限制" }
        val source = body.source()
        require(!source.request(limit + 1)) { "同步内容超过容量限制" }
        JSONObject(source.readUtf8())
    }

    suspend fun syncLan(client: LanClient) = withContext(Dispatchers.IO) {
        initialize()
        val device = client.connection.optString("deviceId")
        val server = client.connection.optString("serverId")
        val vault = client.connection.optString("vaultId")
        val identity = "$server/$device/$vault"
        try {
            val old = lock.withLock { lan.optJSONObject("snapshot")?.takeIf { lan.optString("identity") == identity } }
            val query = old?.let { "?source=${it.getString("source")}&revision=${it.getLong("revision")}" }.orEmpty()
            val result = read(client.execute("/v1/notes/offline$query"), LIMIT)
            lock.withLock {
                if (result.optBoolean("unchanged")) return@withLock
                validate(result)
                val active = lan.optJSONObject("snapshot")
                if (active?.optString("source") == result.getString("source") &&
                    active.optLong("revision") >= result.getLong("revision") && lan.optString("identity") == identity) return@withLock
                val next = JSONObject().put("identity", identity).put("snapshot", result)
                save(lanFile, next); lan = next; publish()
            }
            state.update { it.copy(lanStatus = "局域网已同步") }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: Exception) { state.update { it.copy(lanStatus = e.message ?: "局域网同步失败") } }
    }

    fun authorization(context: Context, email: String) = Identity.getAuthorizationClient(context).authorize(
        AuthorizationRequest.builder().setRequestedScopes(listOf(Scope("https://www.googleapis.com/auth/drive.appdata")))
            .setAccount(Account(email, "com.google")).build()
    )

    fun driveStatus(message: String) { state.update { it.copy(driveStatus = message) } }

    suspend fun forgetDrive() = withContext(Dispatchers.IO) {
        lock.withLock {
            accountEpoch++
            driveFile.delete(); drive = JSONObject()
            publish()
            driveStatus("")
        }
    }

    suspend fun forgetLan() = withContext(Dispatchers.IO) {
        lock.withLock { lanFile.delete(); lan = JSONObject(); publish() }
    }

    private val pulling = Mutex()
    suspend fun syncDrive(token: String, choose: Boolean) = withContext(Dispatchers.IO) {
        if (!pulling.tryLock()) return@withContext
        try {
            initialize()
            val epoch = accountEpoch
            fun get(url: String, limit: Long = 256 * 1024): JSONObject = read(
                cloud.newCall(Request.Builder().url(url).header("Authorization", "Bearer $token").build()).execute(), limit
            )
            driveStatus("正在检查 Google Drive…")
            val user = get("$DRIVE/about?fields=user(emailAddress,permissionId)").getJSONObject("user")
            val owner = user.getString("permissionId")
            val email = user.getString("emailAddress")
            val previous = lock.withLock {
                if (epoch != accountEpoch) return@withContext
                if (!choose && drive.optString("owner") != owner) error("Google 账号已变化，请重新连接")
                if (drive.optString("owner") != owner) {
                    val next = JSONObject().put("owner", owner).put("email", email).put("copies", JSONObject())
                    save(driveFile, next); drive = next; publish()
                }
                drive.getJSONObject("copies")
            }
            val next = JSONObject()
            var page = ""
            var totalBytes = 0L
            do {
                val url = "$DRIVE/files".toHttpUrl().newBuilder()
                    .addQueryParameter("spaces", "appDataFolder")
                    .addQueryParameter("q", "name contains 'study-mate-notes-v1-'")
                    .addQueryParameter("fields", "nextPageToken,files(id,name,description,size)")
                    .addQueryParameter("pageSize", "100")
                    .apply { if (page.isNotBlank()) addQueryParameter("pageToken", page) }.build()
                val result = get(url.toString())
                val files = result.optJSONArray("files") ?: JSONArray()
                for (i in 0 until files.length()) {
                    val file = files.getJSONObject(i)
                    val source = filePattern.matchEntire(file.getString("name"))?.groupValues?.get(1) ?: continue
                    val revision = file.optString("description").toLongOrNull() ?: continue
                    val size = file.optLong("size", LIMIT + 1)
                    totalBytes += size
                    require(size in 1..LIMIT && totalBytes <= 2 * LIMIT) { "Drive 笔记副本超过 48 MiB，请减少同步内容" }
                    require(!next.has(source)) { "Drive 中存在重复的笔记副本" }
                    val old = previous.optJSONObject(source)
                    val copy = if (old?.optLong("revision") == revision) old else {
                        val download = "$DRIVE/files".toHttpUrl().newBuilder().addPathSegment(file.getString("id"))
                            .addQueryParameter("alt", "media").build()
                        validate(get(download.toString(), LIMIT), source)
                    }
                    next.put(source, copy)
                }
                page = result.optString("nextPageToken")
            } while (page.isNotBlank())
            lock.withLock {
                if (epoch != accountEpoch) return@withContext
                val data = JSONObject().put("owner", owner).put("email", email).put("copies", next)
                if (data.toString() != drive.toString()) { save(driveFile, data); drive = data; publish() }
            }
            // Bidirectionally sync handwriting pads for each synced source (non-fatal if Drive ink sync fails)
            var inkChanged = false
            val sourceKeys = next.keys()
            while (sourceKeys.hasNext()) {
                val src = sourceKeys.next()
                runCatching {
                    if (syncDriveInkForSource(token, src)) inkChanged = true
                }
            }
            state.update {
                it.copy(
                    driveStatus = "Google Drive 已同步",
                    inkSyncNonce = if (inkChanged) it.inkSyncNonce + 1 else it.inkSyncNonce,
                )
            }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: Exception) { driveStatus(e.message ?: "Google Drive 同步失败") }
        finally { pulling.unlock() }
    }

    private fun syncDriveInkForSource(token: String, source: String): Boolean {
        val fileName = "study-mate-ink-v1-$source.json"
        val listUrl = "$DRIVE/files".toHttpUrl().newBuilder()
            .addQueryParameter("spaces", "appDataFolder")
            .addQueryParameter("q", "name = '$fileName'")
            .addQueryParameter("fields", "files(id,description,size)")
            .addQueryParameter("pageSize", "10")
            .build()
        val listRes = read(
            cloud.newCall(Request.Builder().url(listUrl).header("Authorization", "Bearer $token").build()).execute(),
            256 * 1024,
        )
        val existingId = listRes.optJSONArray("files")?.optJSONObject(0)?.optString("id").orEmpty()
        val remoteNotes = JSONObject()
        if (existingId.isNotBlank()) {
            val dlUrl = "$DRIVE/files".toHttpUrl().newBuilder()
                .addPathSegment(existingId)
                .addQueryParameter("alt", "media")
                .build()
            val remoteDoc = read(
                cloud.newCall(Request.Builder().url(dlUrl).header("Authorization", "Bearer $token").build()).execute(),
                INK_DRIVE_LIMIT,
            )
            if (remoteDoc.optInt("schema") == 1) {
                remoteDoc.optJSONObject("notes")?.let { notesObj ->
                    val keys = notesObj.keys()
                    while (keys.hasNext()) {
                        val p = keys.next()
                        notesObj.optJSONArray(p)?.let { remoteNotes.put(p, it) }
                    }
                }
            }
        }

        val primaryScope = vaultIdForSource(source) ?: source
        val localScopeIds = listOf(primaryScope, source).distinct()
        val localNotes = inkStore.listScopePadsJson(localScopeIds)

        val allPaths = linkedSetOf<String>()
        localNotes.keys().forEach { allPaths.add(it) }
        remoteNotes.keys().forEach { allPaths.add(it) }
        if (allPaths.isEmpty()) return false

        val mergedNotes = JSONObject()
        var localChanged = false
        for (notePath in allPaths.sorted()) {
            val beforeLocal = inkStore.load(primaryScope, notePath, "").optJSONArray("pads")?.toString() ?: "[]"
            val localForPath = localNotes.optJSONArray(notePath) ?: JSONArray()
            val remoteForPath = remoteNotes.optJSONArray(notePath) ?: JSONArray()
            // Ensure local pads from alias scopes are merged into primaryScope first
            if (localForPath.length() > 0) {
                inkStore.mergePads(primaryScope, notePath, localForPath)
            }
            val merged = inkStore.mergePads(primaryScope, notePath, remoteForPath)
            if (merged.toString() != beforeLocal) localChanged = true
            if (merged.length() > 0) mergedNotes.put(notePath, merged)
        }

        if (mergedNotes.toString() != remoteNotes.toString() && (existingId.isNotBlank() || mergedNotes.length() > 0)) {
            val payload = JSONObject()
                .put("schema", 1)
                .put("source", source)
                .put("updatedAt", System.currentTimeMillis())
                .put("notes", mergedNotes)
                .toString()
            val bytes = payload.toByteArray(Charsets.UTF_8)
            if (bytes.size <= INK_DRIVE_LIMIT) {
                if (existingId.isBlank()) {
                    val boundary = "studymate_ink_${System.nanoTime()}"
                    val meta = JSONObject()
                        .put("name", fileName)
                        .put("description", System.currentTimeMillis().toString())
                        .put("parents", JSONArray().put("appDataFolder"))
                        .toString()
                    val bodyStr = "--$boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n$meta\r\n" +
                        "--$boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n$payload\r\n--$boundary--"
                    val createUrl = "$DRIVE_UPLOAD/files?uploadType=multipart&fields=id"
                    val req = Request.Builder()
                        .url(createUrl)
                        .header("Authorization", "Bearer $token")
                        .post(bodyStr.toRequestBody("multipart/related; boundary=$boundary".toMediaType()))
                        .build()
                    cloud.newCall(req).execute().use { resp -> check(resp.isSuccessful) { "上传手写栏失败（HTTP ${resp.code}）" } }
                } else {
                    val patchUrl = "$DRIVE_UPLOAD/files/$existingId?uploadType=media&fields=id"
                    val req = Request.Builder()
                        .url(patchUrl)
                        .header("Authorization", "Bearer $token")
                        .patch(bytes.toRequestBody("application/json; charset=UTF-8".toMediaType()))
                        .build()
                    cloud.newCall(req).execute().use { resp -> check(resp.isSuccessful) { "更新手写栏失败（HTTP ${resp.code}）" } }
                }
            }
        }
        return localChanged
    }

    fun reader(source: String): OfflineReader? = copies[source]?.let(::OfflineReader)

    fun vaultIdForSource(source: String): String? =
        lanVaultBySource?.takeIf { it.first == source }?.second

    fun sourcesForVault(vaultId: String): List<String> =
        lanVaultBySource?.takeIf { it.second == vaultId }?.let { listOf(it.first) } ?: emptyList()
}

internal class OfflineReader(private val copy: JSONObject) {
    val revision = copy.getLong("revision")
    private val notes = copy.getJSONArray("notes").let { rows ->
        (0 until rows.length()).map { rows.getJSONObject(it) }.associateBy { it.getString("path") }
    }
    fun note(path: String): JSONObject = notes[path] ?: error("这篇笔记未同步")
    private fun key(args: JSONObject) = (if (args.getBoolean("wiki")) "1:" else "0:") + args.getString("target")
    fun resolve(args: JSONObject): JSONObject =
        note(args.getString("base")).getJSONObject("links").optJSONObject(key(args)) ?: error("目标笔记未同步")
    fun image(args: JSONObject): WebResourceResponse {
        val id = note(args.getString("base")).getJSONObject("images").getString(key(args))
        val image = copy.getJSONObject("images").getJSONObject(id)
        val mime = image.getString("mime")
        require(mime in imageTypes)
        return WebResourceResponse(mime, null, 200, "OK",
            mapOf("Content-Security-Policy" to "default-src 'none'; sandbox", "X-Content-Type-Options" to "nosniff"),
            ByteArrayInputStream(Base64.decode(image.getString("data"), Base64.DEFAULT)))
    }
}
