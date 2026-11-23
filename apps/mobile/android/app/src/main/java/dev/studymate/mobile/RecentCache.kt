package dev.studymate.mobile
import android.content.Context
import org.json.JSONObject
import java.security.MessageDigest

/** Encrypted, bounded recent notes and uncertain submission journal. */
class RecentCache(context: Context, identity: String) {
    private val store = SecureStore(context, "recent-" + MessageDigest.getInstance("SHA-256").digest(identity.toByteArray()).joinToString("") { "%02x".format(it) })
    private var data = runCatching { store.load()?.let { JSONObject(it) } }.getOrNull() ?: JSONObject()
    @Synchronized fun get(key: String): JSONObject? {
        data.optJSONObject(key)?.let { return JSONObject(it.toString()) }
        if (key == "snapshot") {
            val notes = data.keys().asSequence().filter { it.startsWith("note:") }.map { data.getJSONObject(it) }.toList()
            if (notes.isNotEmpty()) return JSONObject().put("chat", JSONObject()).put("notes", org.json.JSONArray(notes.map { JSONObject().put("path", it.getString("path")).put("name", it.getString("path")) }))
        }
        return null
    }
    @Synchronized fun put(key: String, value: JSONObject) {
        if (value.toString().toByteArray().size > 512 * 1024) return
        data.remove(key); data.put(key, value)
        while (data.keys().asSequence().count { it.startsWith("note:") } > 12 || data.toString().toByteArray().size > 2 * 1024 * 1024) {
            val victim = data.keys().asSequence().firstOrNull { it.startsWith("note:") } ?: break
            data.remove(victim)
        }
        store.save(data.toString())
    }
    @Synchronized fun remove(key: String) { data.remove(key); store.save(data.toString()) }
    @Synchronized fun clear() { data = JSONObject(); store.clear() }
}
