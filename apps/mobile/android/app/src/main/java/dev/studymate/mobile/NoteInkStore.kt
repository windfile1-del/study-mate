package dev.studymate.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

internal data class InkLoadData(
    val pads: List<Map<String, Any?>>,
    val tempStrokes: List<Map<String, Any?>>,
    val tempClearedByChange: Boolean,
)

internal object MiniJson {
    fun parse(text: String): Any? {
        val parser = Parser(text)
        val value = parser.readValue()
        parser.skipWhitespace()
        require(parser.atEnd()) { "JSON 末尾有多余字符" }
        return value
    }

    fun stringify(value: Any?): String {
        val sb = StringBuilder()
        write(value, sb)
        return sb.toString()
    }

    private fun write(value: Any?, sb: StringBuilder) {
        when (value) {
            null -> sb.append("null")
            is Boolean -> sb.append(if (value) "true" else "false")
            is Number -> sb.append(value.toString())
            is String -> writeString(value, sb)
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) sb.append(',')
                    first = false
                    writeString(k.toString(), sb)
                    sb.append(':')
                    write(v, sb)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (item in value) {
                    if (!first) sb.append(',')
                    first = false
                    write(item, sb)
                }
                sb.append(']')
            }
            else -> writeString(value.toString(), sb)
        }
    }

    private fun writeString(s: String, sb: StringBuilder) {
        sb.append('"')
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\u2028' -> sb.append("\\u2028")
                '\u2029' -> sb.append("\\u2029")
                else -> if (ch.code < 0x20) sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
    }

    private class Parser(private val src: String) {
        private var pos = 0

        fun atEnd(): Boolean = pos >= src.length

        fun skipWhitespace() {
            while (pos < src.length && src[pos] in charArrayOf(' ', '\t', '\r', '\n')) pos++
        }

        fun readValue(): Any? {
            skipWhitespace()
            require(pos < src.length) { "JSON 提前结束" }
            return when (src[pos]) {
                '{' -> readObject()
                '[' -> readArray()
                '"' -> readString()
                't' -> { requireLiteral("true"); true }
                'f' -> { requireLiteral("false"); false }
                'n' -> { requireLiteral("null"); null }
                else -> readNumber()
            }
        }

        private fun requireLiteral(lit: String) {
            require(src.startsWith(lit, pos)) { "无效 JSON 字面量" }
            pos += lit.length
        }

        private fun readObject(): Map<String, Any?> {
            pos++ // {
            val map = LinkedHashMap<String, Any?>()
            skipWhitespace()
            if (pos < src.length && src[pos] == '}') {
                pos++
                return map
            }
            while (true) {
                skipWhitespace()
                require(pos < src.length && src[pos] == '"') { "预期对象键名" }
                val key = readString()
                skipWhitespace()
                require(pos < src.length && src[pos] == ':') { "预期冒号" }
                pos++
                map[key] = readValue()
                skipWhitespace()
                require(pos < src.length) { "对象未闭合" }
                when (src[pos]) {
                    ',' -> pos++
                    '}' -> { pos++; return map }
                    else -> error("对象分隔符无效")
                }
            }
        }

        private fun readArray(): List<Any?> {
            pos++ // [
            val list = ArrayList<Any?>()
            skipWhitespace()
            if (pos < src.length && src[pos] == ']') {
                pos++
                return list
            }
            while (true) {
                list.add(readValue())
                skipWhitespace()
                require(pos < src.length) { "数组未闭合" }
                when (src[pos]) {
                    ',' -> pos++
                    ']' -> { pos++; return list }
                    else -> error("数组分隔符无效")
                }
            }
        }

        private fun readString(): String {
            pos++ // "
            val sb = StringBuilder()
            while (pos < src.length) {
                val ch = src[pos++]
                if (ch == '"') return sb.toString()
                if (ch == '\\') {
                    require(pos < src.length) { "转义字符不完整" }
                    when (val esc = src[pos++]) {
                        '"', '\\', '/' -> sb.append(esc)
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            require(pos + 4 <= src.length) { "Unicode 转义不完整" }
                            val code = src.substring(pos, pos + 4).toInt(16)
                            sb.append(code.toChar())
                            pos += 4
                        }
                        else -> error("未知转义 \\$esc")
                    }
                } else {
                    sb.append(ch)
                }
            }
            error("字符串未闭合")
        }

        private fun readNumber(): Number {
            val start = pos
            if (src[pos] == '-') pos++
            while (pos < src.length && src[pos].isDigit()) pos++
            var isFloat = false
            if (pos < src.length && src[pos] == '.') {
                isFloat = true
                pos++
                require(pos < src.length && src[pos].isDigit()) { "数字格式错误" }
                while (pos < src.length && src[pos].isDigit()) pos++
            }
            if (pos < src.length && (src[pos] == 'e' || src[pos] == 'E')) {
                isFloat = true
                pos++
                if (pos < src.length && (src[pos] == '+' || src[pos] == '-')) pos++
                require(pos < src.length && src[pos].isDigit()) { "指数格式错误" }
                while (pos < src.length && src[pos].isDigit()) pos++
            }
            val raw = src.substring(start, pos)
            require(raw.isNotEmpty() && raw != "-") { "无效数字" }
            return if (isFloat) raw.toDouble() else raw.toLongOrNull() ?: raw.toDouble()
        }
    }
}

class NoteInkStore(
    private val padsDir: File,
    private val tempDir: File,
) {
    constructor(context: Context) : this(
        File(context.noBackupFilesDir, "note-ink-pads"),
        File(context.cacheDir, "note-temp-ink"),
    )

    companion object {
        private const val MAX_PADS_PER_NOTE = 40
        private const val MAX_STROKES_PER_GROUP = 1000
        private const val MAX_POINTS_PER_STROKE = 2000
        private const val MAX_PAD_TOTAL_POINTS = 80_000
        private const val MAX_TEMP_TOTAL_POINTS = 40_000
        private const val MAX_PAD_FILE_BYTES = 2 * 1024 * 1024
        private const val MAX_TEMP_FILE_BYTES = 1024 * 1024
        private const val TOMBSTONE_TTL_MS = 30L * 24L * 60L * 60L * 1000L
        private val sha64Regex = Regex("^[a-f0-9]{64}$")

        fun sha256Hex(value: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
            return digest.joinToString("") { "%02x".format(it) }
        }

        fun contentHash(content: String, serverVersion: String = ""): String {
            val trimmed = serverVersion.trim()
            return if (sha64Regex.matches(trimmed)) trimmed else sha256Hex(content)
        }

        fun noteKey(scopeId: String, path: String): String = sha256Hex("$scopeId\n$path")

        private fun numberLong(value: Any?): Long = when (value) {
            is Number -> value.toLong()
            is String -> value.toLongOrNull() ?: 0L
            else -> 0L
        }

        private fun padVersionTimestamp(pad: Map<String, Any?>): Long =
            maxOf(numberLong(pad["updatedAt"]), numberLong(pad["deletedAt"]))

        private fun isDeleted(pad: Map<String, Any?>): Boolean = numberLong(pad["deletedAt"]) > 0L

        private fun strokeCount(pad: Map<String, Any?>): Int = (pad["strokes"] as? List<*>)?.size ?: 0

        /**
         * Conflict-free per-pad LWW merge with tombstone preservation.
         * Mirrors apps/desktop/src/shared/note-ink.ts `mergeHandwritingPads`.
         */
        internal fun mergePadLists(
            localPads: List<Map<String, Any?>>,
            remotePads: List<Map<String, Any?>>,
            now: Long = System.currentTimeMillis(),
        ): List<Map<String, Any?>> {
            val byId = LinkedHashMap<String, Map<String, Any?>>()
            fun consider(candidate: Map<String, Any?>) {
                val id = candidate["id"] as? String ?: return
                if (id.isBlank()) return
                val existing = byId[id]
                if (existing == null) {
                    byId[id] = candidate
                    return
                }
                val existingTs = padVersionTimestamp(existing)
                val candidateTs = padVersionTimestamp(candidate)
                if (candidateTs > existingTs) {
                    byId[id] = candidate
                    return
                }
                if (candidateTs < existingTs) return

                val existingDel = isDeleted(existing)
                val candidateDel = isDeleted(candidate)
                if (candidateDel && !existingDel) {
                    byId[id] = candidate
                } else if (!candidateDel && !existingDel && strokeCount(candidate) > strokeCount(existing)) {
                    byId[id] = candidate
                }
            }

            localPads.forEach(::consider)
            remotePads.forEach(::consider)

            return byId.values
                .filter { pad ->
                    val deletedAt = numberLong(pad["deletedAt"])
                    deletedAt <= 0L || (now - deletedAt) <= TOMBSTONE_TTL_MS
                }
                .sortedWith(
                    compareBy<Map<String, Any?>> { numberLong(it["createdAt"]) }
                        .thenBy { (it["id"] as? String).orEmpty() },
                )
                .take(MAX_PADS_PER_NOTE)
        }
    }

    private fun padFile(scopeId: String, path: String): File = File(padsDir, noteKey(scopeId, path) + ".json")

    private fun tempFile(scopeId: String, path: String): File = File(tempDir, noteKey(scopeId, path) + ".json")

    @Suppress("UNCHECKED_CAST")
    private fun validateStrokeList(strokes: List<*>, pointBudget: Int): Int {
        require(strokes.size <= MAX_STROKES_PER_GROUP) { "单区笔迹数量超出限制。" }
        var total = 0
        for (raw in strokes) {
            val stroke = raw as? Map<String, Any?> ?: error("笔迹格式无效。")
            val points = stroke["points"] as? List<*> ?: error("笔迹点集无效。")
            require(points.size in 1..MAX_POINTS_PER_STROKE) { "单笔采样点超出限制。" }
            total += points.size
            require(total <= pointBudget) { "笔迹总点数超出限制，请清理部分笔迹后再试。" }
        }
        return total
    }

    private fun atomicWrite(target: File, content: String, maxBytes: Int) {
        val bytes = content.toByteArray(Charsets.UTF_8)
        require(bytes.size <= maxBytes) { "手写数据体积超出限制。" }
        val parent = requireNotNull(target.parentFile)
        if (!parent.exists()) parent.mkdirs()
        val tmp = File(parent, target.name + ".tmp." + System.nanoTime())
        try {
            tmp.writeBytes(bytes)
            if (target.exists()) target.delete()
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, overwrite = true)
                tmp.delete()
            }
        } catch (e: Exception) {
            tmp.delete()
            throw e
        }
    }

    @Suppress("UNCHECKED_CAST")
    @Synchronized
    internal fun loadData(scopeId: String, path: String, contentHash: String): InkLoadData {
        val pads: List<Map<String, Any?>> = runCatching {
            val file = padFile(scopeId, path)
            if (!file.isFile) emptyList()
            else {
                val root = MiniJson.parse(file.readText(Charsets.UTF_8)) as? Map<String, Any?>
                (root?.get("pads") as? List<*>)?.mapNotNull { it as? Map<String, Any?> } ?: emptyList()
            }
        }.getOrElse { emptyList() }

        var tempStrokes: List<Map<String, Any?>> = emptyList()
        var tempClearedByChange = false
        val tFile = tempFile(scopeId, path)
        if (tFile.isFile) {
            runCatching {
                val stored = MiniJson.parse(tFile.readText(Charsets.UTF_8)) as? Map<String, Any?> ?: error("corrupt")
                val storedHash = stored["contentHash"] as? String ?: ""
                val storedStrokes = (stored["strokes"] as? List<*>)?.mapNotNull { it as? Map<String, Any?> } ?: emptyList()
                if (contentHash.isNotBlank() && storedHash == contentHash) {
                    tempStrokes = storedStrokes
                } else {
                    tempClearedByChange = storedStrokes.isNotEmpty()
                    tFile.delete()
                }
            }.onFailure {
                tFile.delete()
            }
        }

        return InkLoadData(pads, tempStrokes, tempClearedByChange)
    }

    @Synchronized
    fun loadRaw(scopeId: String, path: String, contentHash: String): String {
        val data = loadData(scopeId, path, contentHash)
        return MiniJson.stringify(
            linkedMapOf(
                "pads" to data.pads,
                "tempStrokes" to data.tempStrokes,
                "tempClearedByChange" to data.tempClearedByChange,
            ),
        )
    }

    @Synchronized
    fun load(scopeId: String, path: String, contentHash: String): JSONObject =
        JSONObject(loadRaw(scopeId, path, contentHash))

    @Suppress("UNCHECKED_CAST")
    @Synchronized
    fun savePadsRaw(scopeId: String, path: String, padsJsonArray: String) {
        require(path.isNotBlank()) { "笔记路径不能为空。" }
        val pads = MiniJson.parse(padsJsonArray) as? List<*> ?: error("手写栏列表格式无效。")
        require(pads.size <= MAX_PADS_PER_NOTE) { "单篇笔记最多支持 $MAX_PADS_PER_NOTE 个手写栏。" }
        val file = padFile(scopeId, path)
        if (pads.isEmpty()) {
            if (file.exists()) file.delete()
            return
        }
        var totalPoints = 0
        for (rawPad in pads) {
            val pad = rawPad as? Map<String, Any?> ?: error("手写栏格式无效。")
            val strokes = pad["strokes"] as? List<*> ?: emptyList<Any?>()
            totalPoints += validateStrokeList(strokes, MAX_PAD_TOTAL_POINTS - totalPoints)
        }
        val payload = linkedMapOf(
            "schema" to 1,
            "scopeId" to scopeId,
            "path" to path,
            "updatedAt" to System.currentTimeMillis(),
            "pads" to pads,
        )
        atomicWrite(file, MiniJson.stringify(payload), MAX_PAD_FILE_BYTES)
    }

    @Synchronized
    fun savePads(scopeId: String, path: String, pads: JSONArray) =
        savePadsRaw(scopeId, path, pads.toString())

    @Suppress("UNCHECKED_CAST")
    @Synchronized
    internal fun mergePadsRaw(
        scopeId: String,
        path: String,
        remotePadsJsonArray: String,
        now: Long = System.currentTimeMillis(),
    ): String {
        val localPads = loadData(scopeId, path, "").pads
        val remotePads = (MiniJson.parse(remotePadsJsonArray) as? List<*>)
            ?.mapNotNull { it as? Map<String, Any?> }
            ?: emptyList()
        val merged = mergePadLists(localPads, remotePads, now)
        val mergedJson = MiniJson.stringify(merged)
        if (mergedJson != MiniJson.stringify(localPads)) {
            savePadsRaw(scopeId, path, mergedJson)
        }
        return mergedJson
    }

    @Synchronized
    fun mergePads(scopeId: String, path: String, remotePads: JSONArray): JSONArray =
        JSONArray(mergePadsRaw(scopeId, path, remotePads.toString()))

    @Suppress("UNCHECKED_CAST")
    @Synchronized
    internal fun listScopePadsRaw(scopeIds: Collection<String>): Map<String, List<Map<String, Any?>>> {
        if (!padsDir.isDirectory || scopeIds.isEmpty()) return emptyMap()
        val wanted = scopeIds.filter { it.isNotBlank() }.toSet()
        if (wanted.isEmpty()) return emptyMap()
        val byPath = LinkedHashMap<String, List<Map<String, Any?>>>()
        padsDir.listFiles()?.forEach { file ->
            if (!file.isFile || !file.name.endsWith(".json")) return@forEach
            runCatching {
                val root = MiniJson.parse(file.readText(Charsets.UTF_8)) as? Map<String, Any?> ?: return@runCatching
                val scope = root["scopeId"] as? String ?: return@runCatching
                val notePath = root["path"] as? String ?: return@runCatching
                if (scope !in wanted || notePath.isBlank()) return@runCatching
                val pads = (root["pads"] as? List<*>)?.mapNotNull { it as? Map<String, Any?> } ?: emptyList()
                if (pads.isEmpty()) return@runCatching
                val existing = byPath[notePath]
                byPath[notePath] = if (existing == null) pads else mergePadLists(existing, pads)
            }
        }
        return byPath
    }

    @Synchronized
    fun listScopePadsJson(scopeIds: Collection<String>): JSONObject {
        val out = JSONObject()
        for ((notePath, pads) in listScopePadsRaw(scopeIds)) {
            out.put(notePath, JSONArray(MiniJson.stringify(pads)))
        }
        return out
    }

    @Synchronized
    fun saveTempInkRaw(scopeId: String, path: String, contentHash: String, strokesJsonArray: String) {
        require(path.isNotBlank()) { "笔记路径不能为空。" }
        val strokes = MiniJson.parse(strokesJsonArray) as? List<*> ?: error("临时手写数据格式无效。")
        val file = tempFile(scopeId, path)
        if (strokes.isEmpty() || contentHash.isBlank()) {
            if (file.exists()) file.delete()
            return
        }
        validateStrokeList(strokes, MAX_TEMP_TOTAL_POINTS)
        val payload = linkedMapOf(
            "schema" to 1,
            "scopeId" to scopeId,
            "path" to path,
            "contentHash" to contentHash,
            "updatedAt" to System.currentTimeMillis(),
            "strokes" to strokes,
        )
        atomicWrite(file, MiniJson.stringify(payload), MAX_TEMP_FILE_BYTES)
    }

    @Synchronized
    fun saveTempInk(scopeId: String, path: String, contentHash: String, strokes: JSONArray) =
        saveTempInkRaw(scopeId, path, contentHash, strokes.toString())

    @Synchronized
    fun clearTempInk(scopeId: String, path: String) {
        val file = tempFile(scopeId, path)
        if (file.exists()) file.delete()
    }

    @Synchronized
    fun clearAllTempInk() {
        if (!tempDir.isDirectory) return
        tempDir.listFiles()?.forEach { file ->
            if (file.isFile && file.name.endsWith(".json")) file.delete()
        }
    }
}
