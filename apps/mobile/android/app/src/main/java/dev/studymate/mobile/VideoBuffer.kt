package dev.studymate.mobile
import android.content.Context
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache

@androidx.media3.common.util.UnstableApi
object VideoBuffer {
    private var instance: SimpleCache? = null
    @Synchronized fun get(context: Context): SimpleCache = instance ?: SimpleCache(java.io.File(context.cacheDir, "recent-video"), LeastRecentlyUsedCacheEvictor(128L * 1024 * 1024), StandaloneDatabaseProvider(context.applicationContext)).also { instance = it }
    @Synchronized fun clear(context: Context) { val cache = get(context); cache.keys.toList().forEach { cache.removeResource(it) } }
}
