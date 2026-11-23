package dev.studymate.mobile

import android.app.Application
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.util.UUID

data class VideoUi(
    val sourceId: String = "", val title: String = "", val position: Double = 0.0, val duration: Double = 0.0,
    val rate: Float = 1f, val playing: Boolean = false, val loading: Boolean = false,
    val error: String = "", val notice: String = "", val fullscreen: Boolean = false,
    val revision: Int = 0, val epoch: Int = 0
)

/** All ExoPlayer access stays on the main looper. HTTP and progress writes stay on IO. */
@androidx.media3.common.util.UnstableApi
class TabletPlayback(private val app: Application, private val scope: CoroutineScope, private val remote: () -> LanClient?) {
    private val state = MutableStateFlow(VideoUi())
    val ui = state.asStateFlow()
    var player: ExoPlayer? = null; private set
    private var preparation: Job? = null
    private var generation = 0
    private var sessionId = ""
    private var sequence = 0
    private var background = false
    private var progressTick = 0
    private var journal: RecentCache? = null
    private var journalIdentity = ""
    init {
        scope.launch {
            while (isActive) {
                delay(500)
                if (!background && player != null) {
                    sample()
                    if (++progressTick % 10 == 0) checkpoint()
                }
            }
        }
    }
    private fun sample() {
        val p = player ?: return
        val old = state.value
        val duration = if (p.duration > 0) p.duration / 1000.0 else old.duration
        state.value = old.copy(position = (p.currentPosition / 1000.0).coerceAtLeast(0.0), duration = duration, rate = p.playbackParameters.speed, playing = p.isPlaying, loading = p.playbackState == Player.STATE_BUFFERING)
    }
    fun open(id: String, title: String, position: Double? = null, rate: Float? = null, autoplay: Boolean = true) {
        check(Looper.myLooper() == Looper.getMainLooper())
        checkpoint(); generation++; val current = generation
        preparation?.cancel(); player?.release(); player = null
        sessionId = ""; sequence = 0
        state.value = VideoUi(sourceId = id, title = title, position = position ?: 0.0, rate = rate ?: 1f, loading = true, revision = state.value.revision + 1, epoch = state.value.epoch + 1)
        preparation = scope.launch {
            try {
                val client = requireNotNull(remote()) { "请先连接电脑。" }
                val result = withContext(Dispatchers.IO) {
                    val identity = client.connection.getString("serverId") + client.connection.optString("deviceId") + client.connection.optString("vaultId")
                    if (identity != journalIdentity) { journalIdentity = identity; journal = RecentCache(app, "progress:" + identity) }
                    val session = client.json("/v1/playback/start", PlaybackStart(id).toJson())
                    val descriptor = client.json("/v1/media/$id/prepare", JSONObject())
                    session to descriptor
                }
                if (current != generation || background) return@launch
                sessionId = result.first.getString("sessionId")
                val saved = journal?.get("note:" + id) ?: result.first.optJSONObject("checkpoint")
                val start = position ?: saved?.optDouble("position") ?: 0.0
                val speed = rate ?: saved?.optDouble("rate")?.toFloat() ?: 1f
                val next = ExoPlayer.Builder(app).setSeekBackIncrementMs(10000).setSeekForwardIncrementMs(10000).build()
                player = next
                next.setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
                next.setHandleAudioBecomingNoisy(true)
                next.addListener(object : Player.Listener {
                    override fun onPlayerError(error: PlaybackException) {
                        if (current == generation) state.value = state.value.copy(loading = false, playing = false, error = "视频暂时无法播放。请检查电脑连接和课程权限，再点重试。")
                    }
                    override fun onEvents(player: Player, events: Player.Events) { if (current == generation) sample() }
                    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                        if (current == generation) { state.value = state.value.copy(epoch = state.value.epoch + 1); sample(); checkpoint() }
                    }
                })
                next.setMediaSource(client.mediaSource(result.second))
                next.seekTo((start * 1000).toLong().coerceAtLeast(0))
                next.setPlaybackSpeed(speed.coerceIn(0.25f, 4f)); next.prepare(); next.playWhenReady = autoplay
                state.value = state.value.copy(position = start, duration = result.second.optDouble("duration", 0.0), rate = speed, revision = state.value.revision + 1)
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (current == generation) state.value = state.value.copy(loading = false, error = e.message ?: "课程准备失败，请重试。") }
        }
    }
    fun toggle() { player?.let { if (it.playbackState == Player.STATE_ENDED) { it.seekTo(0); it.play() } else if (it.playWhenReady) it.pause() else it.play() }; sample(); checkpoint() }
    fun seek(seconds: Double) { player?.seekTo((seconds.coerceIn(0.0, state.value.duration.coerceAtLeast(0.0)) * 1000).toLong()); sample(); checkpoint() }
    fun speed(rate: Float) { player?.setPlaybackSpeed(rate); sample(); checkpoint() }
    fun fullscreen(value: Boolean) { state.value = state.value.copy(fullscreen = value) }
    fun pause() { player?.pause(); sample(); checkpoint() }
    fun retry() { val s = state.value; open(s.sourceId, s.title, s.position, s.rate) }
    fun reference(): RemoteVideoRef? {
        sample(); val s = state.value
        return if (s.sourceId.isBlank() || s.duration <= 0) null else RemoteVideoRef(sourceId = s.sourceId, position = s.position, duration = s.duration, epoch = s.epoch)
    }
    private fun progress(): PlaybackProgress? {
        val s = state.value
        if (sessionId.isBlank() || s.duration <= 0) return null
        return PlaybackProgress(sourceId = s.sourceId, sessionId = sessionId, sequence = sequence++, position = s.position.coerceAtMost(s.duration), duration = s.duration, rate = s.rate.toDouble())
    }
    fun checkpoint() {
        val value = progress() ?: return
        val client = remote() ?: return
        val captured = System.currentTimeMillis()
        val savedJournal = journal
        scope.launch(Dispatchers.IO) {
            val key = "note:" + value.sourceId
            synchronized(savedJournal ?: this@TabletPlayback) {
                val old = savedJournal?.get(key)
                val newer = old == null || if (old.optString("sessionId") == value.sessionId) old.optInt("sequence") <= value.sequence else old.optLong("capturedAt") <= captured
                if (newer) savedJournal?.put(key, value.toJson().put("capturedAt", captured))
            }
            runCatching { client.json("/v1/playback/progress", value.toJson()) }.onSuccess {
                synchronized(savedJournal ?: this@TabletPlayback) {
                    val current = savedJournal?.get(key)
                    if (current?.optString("sessionId") == value.sessionId && current.optInt("sequence") == value.sequence) savedJournal?.remove(key)
                }
                withContext(Dispatchers.Main) { if (value.sessionId == sessionId && state.value.notice.startsWith("进度暂未保存")) state.value = state.value.copy(notice = "") }
            }.onFailure {
                withContext(Dispatchers.Main) { if (value.sessionId == sessionId) state.value = state.value.copy(notice = "进度暂未保存到电脑，请检查连接。") }
            }
        }
    }
    fun handoff() {
        pause(); val p = progress() ?: return
        val client = remote() ?: return
        val request = PlaybackHandoff(UUID.randomUUID().toString(), p.sourceId, p.sessionId, p.sequence, p.position, p.duration, p.rate)
        scope.launch {
            try {
                withContext(Dispatchers.IO) { client.json("/v1/playback/handoff", request.toJson()) }
                state.value = state.value.copy(notice = "已发送。请在电脑「平板连接」中确认继续播放。")
            } catch (e: Exception) { state.value = state.value.copy(notice = "接力未确认送达，请检查电脑后重试。") }
        }
    }
    fun stopForBackground() {
        background = true; pause(); preparation?.cancel(); generation++
        player?.release(); player = null
        state.value = state.value.copy(playing = false, revision = state.value.revision + 1)
    }
    fun foreground() {
        if (!background) return
        background = false
        val s = state.value
        if (s.sourceId.isNotBlank() && remote() != null) open(s.sourceId, s.title, s.position, s.rate, false)
    }
    fun clear() { preparation?.cancel(); generation++; player?.release(); player = null; sessionId = ""; state.value = VideoUi() }
}
