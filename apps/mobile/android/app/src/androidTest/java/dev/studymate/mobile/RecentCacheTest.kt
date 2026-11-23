package dev.studymate.mobile
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*
import java.util.UUID

class RecentCacheTest {
    @Test fun encryptedRecentDataSurvivesRestartAndIsIsolatedAndBounded() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val id = "cache-test-" + UUID.randomUUID()
        val cache = RecentCache(context, id)
        try {
            cache.put("note:one", JSONObject().put("path", "one.md").put("content", "离线阅读正文"))
            cache.put("pending", JSONObject().put("requestId", "frozen-request").put("text", "原问题"))
            val restart = RecentCache(context, id)
            assertEquals("离线阅读正文", restart.get("note:one")!!.getString("content"))
            assertEquals("one.md", restart.get("snapshot")!!.getJSONArray("notes").getJSONObject(0).getString("path"))
            assertEquals("frozen-request", restart.get("pending")!!.getString("requestId"))
            assertNull(RecentCache(context, id + "-other-vault").get("note:one"))
            repeat(30) { cache.put("note:$it", JSONObject().put("content", "fixture-$it")) }
            assertNull(RecentCache(context, id).get("note:0"))
            assertNotNull(RecentCache(context, id).get("note:29"))
            cache.clear(); assertNull(RecentCache(context, id).get("pending"))
        } finally { cache.clear() }
    }
}
